import crypto from 'node:crypto';
import {
  MAX_CONCURRENT_REQUESTS,
  MODELS,
  RATE_LIMIT_PER_MINUTE,
  TOKEN_QUOTA_LIMIT,
  TOKEN_QUOTA_WINDOW_SECONDS,
  UNAVAILABLE_SECONDS,
} from './config.js';

export interface CloudProjectPayload {
  projects: unknown[];
  conversations: unknown[];
  updatedAt: string;
  migrated: boolean;
}

export interface ProjectFileRecord {
  id: string;
  identityKey: string;
  projectId: string;
  filename: string;
  language: string;
  content: string;
  size: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewsItem {
  id: number;
  title: string;
  body: string;
  author: string;
  created_at: string;
}

export interface ApiKeyRecord {
  id: number;
  keyHash: string;
  keyPrefix: string;
  name: string;
  guestToken: string;
  githubLogin: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ApiUsageEvent {
  timestamp: number;
  model: string;
  tokens: number;
  latencyMs: number;
  success: boolean;
  identityKey: string;
}

export interface McpToolRecord {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  enabled: boolean;
}

export interface McpServerRecord {
  id: string;
  name: string;
  url: string;
  encryptedToken: string;
  hasToken: boolean;
  sessionId: string;
  protocolVersion: string;
  tools: McpToolRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface ReferralEntry {
  id: number;
  referrerIdentity: string;
  referredIdentity: string;
  label: string;
  reward: number;
  status: 'pending' | 'completed';
  referrerClaimedAt: string | null;
  referredClaimedAt: string | null;
  createdAt: string;
}

// In-memory store replacing WordPress $wpdb, options, and transients
class MemoryStore {
  aiDisabled = false;
  concurrentRequests = 0;

  disabledModels = new Map<string, boolean>();
  cooldownModels = new Map<string, { until: number; reason: string; status: number }>();

  rateLimits = new Map<string, number[]>();
  tokenQuotas = new Map<string, { tokens: number; resetAt: number }>();

  cloudProjects = new Map<string, CloudProjectPayload>();
  projectFiles = new Map<string, ProjectFileRecord>();

  newsItems: NewsItem[] = [
    {
      id: 1,
      title: 'Ptero AI Chat Migrated to Node.js',
      body: 'Ptero AI Chat is running on Express/Node.js with multi-model streaming, MCP integrations, project workspaces, and API tools.',
      author: 'System',
      created_at: new Date().toISOString(),
    },
  ];
  private nextNewsId = 2;

  modelFeedback = new Map<string, { likes: number; dislikes: number }>();

  apiKeys = new Map<number, ApiKeyRecord>();
  private nextApiKeyId = 1;
  apiUsageEvents: ApiUsageEvent[] = [];

  mcpServers = new Map<string, McpServerRecord[]>();
  githubVerified = new Map<string, { login: string; accessToken: string }>();

  referralRecords: ReferralEntry[] = [];
  private nextReferralId = 1;
  referralCodes = new Map<string, string>(); // identity -> ref code

  private encryptionSecret =
    process.env.MCP_ENCRYPTION_SECRET || crypto.randomBytes(32).toString('hex');

  acquireRequestSlot(): boolean {
    if (this.concurrentRequests >= MAX_CONCURRENT_REQUESTS) {
      return false;
    }
    this.concurrentRequests += 1;
    return true;
  }

  releaseRequestSlot(): void {
    this.concurrentRequests = Math.max(0, this.concurrentRequests - 1);
  }

  isModelAvailable(modelId: string): boolean {
    if (!MODELS[modelId]) return false;
    if (this.disabledModels.get(modelId)) return false;
    const cooldown = this.cooldownModels.get(modelId);
    if (cooldown && cooldown.until > Date.now()) {
      return false;
    }
    if (cooldown && cooldown.until <= Date.now()) {
      this.cooldownModels.delete(modelId);
    }
    return true;
  }

  getDisabledModelIds(): string[] {
    const out: string[] = [];
    for (const [id, disabled] of this.disabledModels.entries()) {
      if (disabled) out.push(id);
    }
    return out;
  }

  getCooldownModelIds(): string[] {
    const now = Date.now();
    const out: string[] = [];
    for (const [id, info] of this.cooldownModels.entries()) {
      if (info.until > now) out.push(id);
      else this.cooldownModels.delete(id);
    }
    return out;
  }

  recordModelFailure(modelId: string, status: number, reason: string): void {
    if (status === 429 || status >= 500 || status === 0) {
      this.cooldownModels.set(modelId, {
        until: Date.now() + UNAVAILABLE_SECONDS * 1000,
        reason,
        status,
      });
    }
  }

  checkRateLimit(identity: string): boolean {
    const now = Date.now();
    const cutoff = now - 60_000;
    const timestamps = (this.rateLimits.get(identity) || []).filter((t) => t > cutoff);
    if (timestamps.length >= RATE_LIMIT_PER_MINUTE) {
      this.rateLimits.set(identity, timestamps);
      return false;
    }
    timestamps.push(now);
    this.rateLimits.set(identity, timestamps);
    return true;
  }

  getTokenQuota(identity: string): { tokens: number; resetAt: number } {
    const now = Math.floor(Date.now() / 1000);
    const existing = this.tokenQuotas.get(identity);
    if (!existing || existing.resetAt <= now) {
      const fresh = { tokens: 0, resetAt: now + TOKEN_QUOTA_WINDOW_SECONDS };
      this.tokenQuotas.set(identity, fresh);
      return fresh;
    }
    return existing;
  }

  checkTokenQuota(identity: string): boolean {
    const data = this.getTokenQuota(identity);
    return data.tokens < TOKEN_QUOTA_LIMIT;
  }

  addTokenUsage(identity: string, model: string, tokens: number, latencyMs = 0, success = true): void {
    const data = this.getTokenQuota(identity);
    data.tokens += Math.max(0, Math.round(tokens));
    this.tokenQuotas.set(identity, data);

    this.apiUsageEvents.push({
      timestamp: Date.now(),
      model,
      tokens: Math.max(0, Math.round(tokens)),
      latencyMs,
      success,
      identityKey: identity,
    });
    if (this.apiUsageEvents.length > 5000) {
      this.apiUsageEvents.splice(0, this.apiUsageEvents.length - 5000);
    }
  }

  adjustFeedback(modelId: string, type: 'like' | 'dislike', delta: number): { likes: number; dislikes: number } {
    const cur = this.modelFeedback.get(modelId) || { likes: 0, dislikes: 0 };
    if (type === 'like') {
      cur.likes = Math.max(0, cur.likes + delta);
    } else {
      cur.dislikes = Math.max(0, cur.dislikes + delta);
    }
    this.modelFeedback.set(modelId, cur);
    return cur;
  }

  addNews(title: string, body: string, author = 'Admin'): NewsItem {
    const item: NewsItem = {
      id: this.nextNewsId++,
      title,
      body,
      author,
      created_at: new Date().toISOString(),
    };
    this.newsItems.unshift(item);
    return item;
  }

  deleteNews(id: number): boolean {
    const idx = this.newsItems.findIndex((n) => n.id === id);
    if (idx === -1) return false;
    this.newsItems.splice(idx, 1);
    return true;
  }

  createApiKey(name: string, guestToken: string, githubLogin: string): { record: ApiKeyRecord; rawKey: string } {
    const secret = crypto.randomBytes(24).toString('hex');
    const rawKey = `ptero_${secret}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const record: ApiKeyRecord = {
      id: this.nextApiKeyId++,
      keyHash,
      keyPrefix: rawKey.slice(0, 12) + '...',
      name: name || 'API Key',
      guestToken,
      githubLogin,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.apiKeys.set(record.id, record);
    return { record, rawKey };
  }

  findApiKeyByBearer(rawKey: string): ApiKeyRecord | null {
    if (!rawKey) return null;
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
    for (const rec of this.apiKeys.values()) {
      if (rec.keyHash === hash && !rec.revokedAt) {
        rec.lastUsedAt = new Date().toISOString();
        return rec;
      }
    }
    return null;
  }

  encryptSecret(secret: string): string {
    if (!secret) return '';
    const key = crypto.createHash('sha256').update(this.encryptionSecret).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  decryptSecret(ciphertext: string): string {
    if (!ciphertext) return '';
    try {
      const buf = Buffer.from(ciphertext, 'base64');
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const data = buf.subarray(28);
      const key = crypto.createHash('sha256').update(this.encryptionSecret).digest();
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
      return '';
    }
  }

  getOrCreateReferralCode(identity: string): string {
    const existing = this.referralCodes.get(identity);
    if (existing) return existing;
    const code = crypto.createHash('sha1').update(identity).digest('hex').slice(0, 10);
    this.referralCodes.set(identity, code);
    return code;
  }

  createReferral(referrerIdentity: string, referredIdentity: string, label: string): ReferralEntry {
    const entry: ReferralEntry = {
      id: this.nextReferralId++,
      referrerIdentity,
      referredIdentity,
      label,
      reward: 50000,
      status: 'completed',
      referrerClaimedAt: null,
      referredClaimedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.referralRecords.push(entry);
    return entry;
  }
}

export const store = new MemoryStore();
