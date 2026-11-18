import express, { Request, Response } from 'express';
import {
  buildApiMessagesFromHistory,
  callChatApi,
  ChatMessage,
  createUuid,
  executeGithubTool,
  expandZipImages,
  fetchGithubRepoSummary,
  fetchLiveWebContext,
  getCandidateModels,
  getChatOutputTokens,
  getGithubToolsSchema,
  normalizeChatMode,
  parseGithubRepo,
  runAgenticTurn,
  sanitizeAttachments,
  streamAgenticTurn,
  streamChatApi,
} from './ai-logic.js';
import {
  DEFAULT_MODEL,
  getApiKeyForModel,
  MAX_FAILOVER_ATTEMPTS,
  MAX_OUTPUT_TOKENS,
  MODELS,
  RATE_LIMIT_PER_MINUTE,
  TOKEN_QUOTA_LIMIT,
  TOKEN_QUOTA_WINDOW_SECONDS,
} from './config.js';
import { store } from './store.js';

function getGuestToken(req: Request): string {
  const raw = String(req.header('x-mlp-guest-token') || req.query.guest || '');
  const clean = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return clean;
}

function resolveIdentity(req: Request): {
  identityKey: string;
  guestToken: string;
  githubLogin: string;
  apiKeyRecord: ReturnType<typeof store.findApiKeyByBearer>;
  isGuest: boolean;
} {
  const authHeader = String(req.header('authorization') || '');
  const xApiKey = String(req.header('x-api-key') || '');
  let bearer = '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (m) bearer = m[1].trim();
  else if (xApiKey) bearer = xApiKey.trim();

  if (bearer) {
    const rec = store.findApiKeyByBearer(bearer);
    if (rec) {
      return {
        identityKey: rec.githubLogin ? `gh:${rec.githubLogin}` : `api:${rec.id}`,
        guestToken: rec.guestToken,
        githubLogin: rec.githubLogin,
        apiKeyRecord: rec,
        isGuest: false,
      };
    }
  }

  const guestToken = getGuestToken(req) || 'anonymous';
  const gh = store.githubVerified.get(guestToken);
  if (gh) {
    return {
      identityKey: `gh:${gh.login}`,
      guestToken,
      githubLogin: gh.login,
      apiKeyRecord: null,
      isGuest: false,
    };
  }
  return {
    identityKey: `guest:${guestToken}`,
    guestToken,
    githubLogin: '',
    apiKeyRecord: null,
    isGuest: true,
  };
}

function sendSse(res: Response, payload: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function extractMcpToolText(result: Record<string, unknown>): string {
  const content = result.content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item) return String((item as { text: unknown }).text || '');
        return JSON.stringify(item);
      })
      .join('\n');
  }
  return JSON.stringify(result, null, 2);
}

async function mcpRpcCall(
  url: string,
  token: string,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string
): Promise<{ result?: Record<string, unknown>; sessionId?: string; error?: string }> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        params,
      }),
    });
    const nextSession = resp.headers.get('mcp-session-id') || sessionId || '';
    const ct = resp.headers.get('content-type') || '';
    const text = await resp.text();

    let parsed: Record<string, unknown> | null = null;
    if (ct.includes('text/event-stream')) {
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        try {
          parsed = JSON.parse(trimmed.slice(5).trim()) as Record<string, unknown>;
        } catch {
          // ignore
        }
      }
    } else {
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }

    if (!resp.ok) {
      return { error: `MCP server returned HTTP ${resp.status}`, sessionId: nextSession };
    }
    if (!parsed) {
      return { error: 'MCP server returned non-JSON response.', sessionId: nextSession };
    }
    if (parsed.error && typeof parsed.error === 'object') {
      const msg = (parsed.error as { message?: string }).message || 'MCP RPC error';
      return { error: msg, sessionId: nextSession };
    }
    return {
      result: (parsed.result as Record<string, unknown>) || {},
      sessionId: nextSession,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'MCP connection failed.' };
  }
}

export function createApiRouter(): express.Router {
  const router = express.Router();

  // 1. Status
  router.get('/status', (_req, res) => {
    const disabled = store.getDisabledModelIds();
    const cooldown = store.getCooldownModelIds();
    res.json({
      disabled: store.aiDisabled,
      disabled_models: [...new Set([...disabled, ...cooldown])],
      cooldown_models: cooldown,
      default_model: DEFAULT_MODEL,
    });
  });

  // 2. Chat (non-streaming)
  router.post('/chat', async (req, res) => {
    if (store.aiDisabled) {
      res.status(503).json({ code: 'ai_disabled', message: 'The chat has been temporarily disabled.' });
      return;
    }
    if (!store.acquireRequestSlot()) {
      res.status(503).json({ code: 'server_busy', message: 'Server busy. Try again in a few seconds.' });
      return;
    }

    try {
      const identity = resolveIdentity(req);
      if (!store.checkRateLimit(identity.identityKey)) {
        res.status(429).json({ code: 'rate_limited', message: 'Too many messages — please slow down.' });
        return;
      }
      if (!store.checkTokenQuota(identity.identityKey)) {
        res.status(429).json({ code: 'quota_exceeded', message: 'Hourly token quota reached.' });
        return;
      }

      const body = (req.body || {}) as Record<string, unknown>;
      const message = typeof body.message === 'string' ? body.message : '';
      const attachments = expandZipImages(sanitizeAttachments(body.attachments));
      const history = Array.isArray(body.history) ? body.history : [];
      const langCode = typeof body.lang === 'string' ? body.lang : 'en';
      const requestedModel = typeof body.model === 'string' ? body.model : DEFAULT_MODEL;
      const requestedMode = typeof body.mode === 'string' ? body.mode : 'fast';
      const githubRepoParam = typeof body.github_repo === 'string' ? body.github_repo : '';

      if (!message.trim() && attachments.length === 0) {
        res.status(400).json({ code: 'empty_message', message: 'Message cannot be empty.' });
        return;
      }

      const chatMode = normalizeChatMode(requestedMode, message, attachments);
      const outputTokens = getChatOutputTokens(chatMode);

      let githubContext = '';
      if (githubRepoParam) {
        const parsedRepo = parseGithubRepo(githubRepoParam);
        if (parsedRepo) {
          const summary = await fetchGithubRepoSummary(parsedRepo.owner, parsedRepo.repo);
          if (!('error' in summary)) {
            githubContext =
              `The user has attached the public GitHub repository "${summary.full_name}" ` +
              `(${summary.language || 'unknown language'}, branch ${summary.default_branch}). ` +
              `Files: ${(summary.files as string[]).slice(0, 60).join(', ')}`;
          }
        }
      }

      const candidates = getCandidateModels(requestedModel);
      let lastError = 'No model API keys are configured. Add a provider key (e.g. MLP_MINIROUTER_KEY or OPENAI_API_KEY) in environment settings.';
      let lastStatus = 500;
      let attempts = 0;

      for (const candidate of candidates) {
        if (!store.isModelAvailable(candidate)) continue;
        const keyInfo = getApiKeyForModel(candidate);
        if ('error' in keyInfo) {
          lastError = keyInfo.error;
          lastStatus = keyInfo.status;
          continue;
        }
        if (attempts >= MAX_FAILOVER_ATTEMPTS) break;
        attempts += 1;

        const cfg = MODELS[candidate];
        const messages = buildApiMessagesFromHistory(
          history,
          message,
          attachments,
          cfg.supportsImages,
          langCode,
          githubContext,
          chatMode
        );
        const webCtx = await fetchLiveWebContext(message);
        if (webCtx) {
          messages[0].content = `${String(messages[0].content)}\n\n${webCtx}`;
        }

        const tools = cfg.supportsTools && githubRepoParam ? getGithubToolsSchema() : null;
        const started = Date.now();
        const result = tools
          ? await runAgenticTurn(
              messages,
              keyInfo.apiModel,
              keyInfo.key,
              keyInfo.url,
              tools,
              executeGithubTool,
              { maxTokens: outputTokens, sampling: cfg.sampling }
            )
          : await callChatApi(messages, keyInfo.apiModel, keyInfo.key, keyInfo.url, null, outputTokens, cfg.sampling);

        const latency = Date.now() - started;
        if ('error' in result) {
          store.recordModelFailure(candidate, result.status, result.error);
          store.addTokenUsage(identity.identityKey, candidate, 0, latency, false);
          lastError = result.error;
          lastStatus = result.status;
          continue;
        }

        const totalTokens = result.usage.total_tokens || Math.ceil((message.length + result.text.length) / 4);
        store.addTokenUsage(identity.identityKey, candidate, totalTokens, latency, true);

        res.json({
          reply: result.text,
          model_used: candidate,
          model_label: cfg.label,
          usage: result.usage,
          mode: chatMode,
        });
        return;
      }

      res.status(lastStatus || 502).json({ code: 'ai_error', message: lastError });
    } finally {
      store.releaseRequestSlot();
    }
  });

  // 3. Chat Stream (SSE)
  router.post('/chat-stream', async (req, res) => {
    if (store.aiDisabled) {
      res.status(503).json({ code: 'ai_disabled', message: 'The chat has been temporarily disabled.' });
      return;
    }
    if (!store.acquireRequestSlot()) {
      res.status(503).json({ code: 'server_busy', message: 'Server busy. Please try again in a few seconds.' });
      return;
    }

    const identity = resolveIdentity(req);
    if (!store.checkRateLimit(identity.identityKey)) {
      store.releaseRequestSlot();
      res.status(429).json({ code: 'rate_limited', message: 'Too many messages — please slow down.' });
      return;
    }
    if (!store.checkTokenQuota(identity.identityKey)) {
      store.releaseRequestSlot();
      res.status(429).json({ code: 'quota_exceeded', message: 'Hourly token quota reached.' });
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const message = typeof body.message === 'string' ? body.message : '';
    const attachments = expandZipImages(sanitizeAttachments(body.attachments));
    const history = Array.isArray(body.history) ? body.history : [];
    const langCode = typeof body.lang === 'string' ? body.lang : 'en';
    const requestedModel = typeof body.model === 'string' ? body.model : DEFAULT_MODEL;
    const requestedMode = typeof body.mode === 'string' ? body.mode : 'fast';
    const githubRepoParam = typeof body.github_repo === 'string' ? body.github_repo : '';

    if (!message.trim() && attachments.length === 0) {
      store.releaseRequestSlot();
      res.status(400).json({ code: 'empty_message', message: 'Message cannot be empty.' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    res.write(`: ${' '.repeat(2048)}\n\n`);
    sendSse(res, {
      phase: 'preparing',
      activity: { type: 'thinking', label: 'Preparing request…' },
    });

    try {
      const chatMode = normalizeChatMode(requestedMode, message, attachments);
      const outputTokens = getChatOutputTokens(chatMode);

      let githubContext = '';
      if (githubRepoParam) {
        const parsedRepo = parseGithubRepo(githubRepoParam);
        if (parsedRepo) {
          sendSse(res, { phase: 'reading', activity: { type: 'reading', label: `Reading ${githubRepoParam}…` } });
          const summary = await fetchGithubRepoSummary(parsedRepo.owner, parsedRepo.repo);
          if (!('error' in summary)) {
            githubContext =
              `The user has attached the public GitHub repository "${summary.full_name}" ` +
              `(${summary.language || 'unknown language'}, branch ${summary.default_branch}). ` +
              `Files: ${(summary.files as string[]).slice(0, 60).join(', ')}`;
          }
        }
      }

      const candidates = getCandidateModels(requestedModel);
      let usedModel: string | null = null;
      let lastErrorMsg =
        'No provider API key is configured. Add a provider key (e.g. MLP_MINIROUTER_KEY or OPENAI_API_KEY) in environment settings.';
      let attempts = 0;

      for (const candidate of candidates) {
        if (!store.isModelAvailable(candidate)) continue;
        const keyInfo = getApiKeyForModel(candidate);
        if ('error' in keyInfo) {
          lastErrorMsg = keyInfo.error;
          continue;
        }
        if (attempts >= MAX_FAILOVER_ATTEMPTS) break;
        attempts += 1;

        const cfg = MODELS[candidate];
        const messages = buildApiMessagesFromHistory(
          history,
          message,
          attachments,
          cfg.supportsImages,
          langCode,
          githubContext,
          chatMode
        );
        const webCtx = await fetchLiveWebContext(message);
        if (webCtx) {
          messages[0].content = `${String(messages[0].content)}\n\n${webCtx}`;
        }

        const tools = cfg.supportsTools && githubRepoParam ? getGithubToolsSchema() : null;
        const started = Date.now();

        sendSse(res, { model: candidate, model_label: cfg.label });

        const emitEvent = (ev: Record<string, unknown>) => sendSse(res, ev);
        const emitKeepalive = () => res.write(': keepalive\n\n');

        const result = tools
          ? await streamAgenticTurn(
              messages,
              keyInfo.apiModel,
              keyInfo.key,
              keyInfo.url,
              tools,
              executeGithubTool,
              emitEvent,
              emitKeepalive,
              {
                maxTokens: outputTokens,
                sampling: cfg.sampling,
                onToolCall: (name) => sendSse(res, { activity: { type: 'reading', label: `Running ${name}…` } }),
              }
            )
          : await streamChatApi(
              messages,
              keyInfo.apiModel,
              keyInfo.key,
              keyInfo.url,
              outputTokens,
              emitEvent,
              emitKeepalive,
              null,
              cfg.sampling
            );

        const latency = Date.now() - started;
        if (result.error || (result.httpCode > 0 && (result.httpCode < 200 || result.httpCode >= 300))) {
          store.recordModelFailure(candidate, result.httpCode || 502, result.error);
          store.addTokenUsage(identity.identityKey, candidate, 0, latency, false);
          lastErrorMsg = result.error || `Provider returned HTTP ${result.httpCode}`;
          continue;
        }

        const tokensUsed = result.usageTokens || Math.ceil((message.length + result.text.length) / 4);
        store.addTokenUsage(identity.identityKey, candidate, tokensUsed, latency, true);
        usedModel = candidate;

        sendSse(res, {
          done: true,
          model_used: candidate,
          model_label: cfg.label,
          reply: result.text,
          thinking: result.thinking,
          usage: { total_tokens: tokensUsed },
          mode: chatMode,
        });
        res.end();
        return;
      }

      if (!usedModel) {
        sendSse(res, { error: lastErrorMsg });
      }
      res.end();
    } catch (err) {
      sendSse(res, { error: err instanceof Error ? err.message : 'Streaming failed.' });
      res.end();
    } finally {
      store.releaseRequestSlot();
    }
  });

  // 4. Usage
  router.get('/usage', (req, res) => {
    const identity = resolveIdentity(req);
    const quota = store.getTokenQuota(identity.identityKey);
    const now = Math.floor(Date.now() / 1000);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
    res.json({
      used: quota.tokens,
      max: TOKEN_QUOTA_LIMIT,
      remaining: Math.max(0, TOKEN_QUOTA_LIMIT - quota.tokens),
      reset_seconds: Math.max(0, quota.resetAt - now),
      window_seconds: TOKEN_QUOTA_WINDOW_SECONDS,
      unlimited: false,
    });
  });

  // 5. News
  router.get('/news', (_req, res) => {
    res.json({ items: store.newsItems });
  });

  router.post('/news', (req, res) => {
    const { title, body } = (req.body || {}) as { title?: string; body?: string };
    if (!title?.trim() || !body?.trim()) {
      res.status(400).json({ code: 'mlp_news_missing_fields', message: 'A title and body are required.' });
      return;
    }
    const item = store.addNews(title.trim().slice(0, 120), body.trim().slice(0, 4000));
    res.status(201).json({ item });
  });

  router.delete('/news/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!store.deleteNews(id)) {
      res.status(404).json({ code: 'not_found', message: 'News item not found.' });
      return;
    }
    res.json({ deleted: true, id });
  });

  // 6. Feedback
  router.post('/feedback', (req, res) => {
    const { model_id, type, action } = (req.body || {}) as {
      model_id?: string;
      type?: string;
      action?: string;
    };
    if (!model_id || !MODELS[model_id]) {
      res.status(400).json({ code: 'mlp_bad_model', message: 'Unknown model.' });
      return;
    }
    if (type !== 'like' && type !== 'dislike') {
      res.status(400).json({ code: 'mlp_bad_type', message: "type must be 'like' or 'dislike'." });
      return;
    }
    const delta = action === 'remove' ? -1 : 1;
    const counts = store.adjustFeedback(model_id, type, delta);
    res.json({ model_id, likes: counts.likes, dislikes: counts.dislikes });
  });

  // 7. GitHub status & repo summary
  router.get('/github/status', (req, res) => {
    const token = getGuestToken(req);
    const gh = token ? store.githubVerified.get(token) : undefined;
    const configured = Boolean(process.env.MLP_GITHUB_CLIENT_ID && process.env.MLP_GITHUB_CLIENT_SECRET);
    res.json({
      configured,
      verified: Boolean(gh),
      github_verified: Boolean(gh),
      login: gh?.login || '',
    });
  });

  router.get('/github/authorize', (req, res) => {
    const clientId = process.env.MLP_GITHUB_CLIENT_ID?.trim();
    const guest = getGuestToken(req);
    if (!clientId) {
      res.status(200).send(
        `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;"><h3>GitHub OAuth Not Configured</h3><p>Set <code>MLP_GITHUB_CLIENT_ID</code> and <code>MLP_GITHUB_CLIENT_SECRET</code> in your environment to enable GitHub login.</p><script>if(window.opener){window.opener.postMessage({source:'mlp-github',success:false},'*');}</script></body></html>`
      );
      return;
    }
    const origin = `${req.protocol}://${req.get('host')}`;
    const callback = `${origin}/mlp/v1/github/callback`;
    const state = Buffer.from(JSON.stringify({ guest })).toString('base64url');
    const url = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(callback)}&scope=read:user&state=${encodeURIComponent(state)}`;
    res.redirect(url);
  });

  router.get('/github/callback', async (req, res) => {
    const code = String(req.query.code || '');
    const stateRaw = String(req.query.state || '');
    let guest = '';
    try {
      const parsed = JSON.parse(Buffer.from(stateRaw, 'base64url').toString('utf8')) as { guest?: string };
      guest = parsed.guest || '';
    } catch {
      guest = '';
    }
    const clientId = process.env.MLP_GITHUB_CLIENT_ID?.trim() || '';
    const clientSecret = process.env.MLP_GITHUB_CLIENT_SECRET?.trim() || '';
    if (!code || !clientId || !clientSecret) {
      res.send(
        `<!DOCTYPE html><html><body><script>if(window.opener){window.opener.postMessage({source:'mlp-github',success:false},'*');}window.close();</script></body></html>`
      );
      return;
    }

    try {
      const tokenResp = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
      });
      const tokenData = (await tokenResp.json()) as { access_token?: string };
      const accessToken = tokenData.access_token || '';
      if (!accessToken) throw new Error('No token');

      const userResp = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'Ptero-AI-Chat' },
      });
      const userData = (await userResp.json()) as { login?: string };
      const login = userData.login || 'github-user';
      if (guest) {
        store.githubVerified.set(guest, { login, accessToken });
      }
      res.send(
        `<!DOCTYPE html><html><body><p>Connected as ${login}. You can close this window.</p><script>if(window.opener){window.opener.postMessage({source:'mlp-github',success:true,mlpGithubVerified:true,login:${JSON.stringify(login)}},'*');}window.close();</script></body></html>`
      );
    } catch {
      res.send(
        `<!DOCTYPE html><html><body><script>if(window.opener){window.opener.postMessage({source:'mlp-github',success:false},'*');}window.close();</script></body></html>`
      );
    }
  });

  router.get('/github/repo-summary', async (req, res) => {
    const repo = String(req.query.repo || '');
    const parsed = parseGithubRepo(repo);
    if (!parsed) {
      res.status(400).json({ code: 'invalid_repo', message: 'Provide a valid owner/repo or GitHub URL.' });
      return;
    }
    const summary = await fetchGithubRepoSummary(parsed.owner, parsed.repo);
    if ('error' in summary && typeof summary.error === 'string') {
      res.status(Number(summary.status) || 502).json({ code: 'github_error', message: summary.error });
      return;
    }
    res.json(summary);
  });

  // 8. Cloud projects & project files (in-memory)
  router.get('/projects/cloud', (req, res) => {
    const identity = resolveIdentity(req);
    const row = store.cloudProjects.get(identity.identityKey);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.json({
      logged_in: true,
      login: identity.githubLogin || identity.guestToken,
      migrated: Boolean(row?.migrated),
      projects: row?.projects || [],
      conversations: row?.conversations || [],
      updated_at: row?.updatedAt || null,
    });
  });

  router.post('/projects/cloud', (req, res) => {
    const identity = resolveIdentity(req);
    const body = (req.body || {}) as { projects?: unknown[]; conversations?: unknown[] };
    const payload = {
      projects: Array.isArray(body.projects) ? body.projects : [],
      conversations: Array.isArray(body.conversations) ? body.conversations : [],
      updatedAt: new Date().toISOString(),
      migrated: store.cloudProjects.get(identity.identityKey)?.migrated || false,
    };
    store.cloudProjects.set(identity.identityKey, payload);
    res.json({ saved: true, updated_at: payload.updatedAt });
  });

  router.post('/projects/cloud/migrate', (req, res) => {
    const identity = resolveIdentity(req);
    const body = (req.body || {}) as { projects?: unknown[]; conversations?: unknown[] };
    const existing = store.cloudProjects.get(identity.identityKey);
    const payload = {
      projects: Array.isArray(body.projects) ? body.projects : existing?.projects || [],
      conversations: Array.isArray(body.conversations) ? body.conversations : existing?.conversations || [],
      updatedAt: new Date().toISOString(),
      migrated: true,
    };
    store.cloudProjects.set(identity.identityKey, payload);
    res.json({ migrated: true, updated_at: payload.updatedAt });
  });

  router.get('/projects/files', (req, res) => {
    const identity = resolveIdentity(req);
    const projectId = String(req.query.project_id || '');
    const files = [...store.projectFiles.values()]
      .filter((f) => f.identityKey === identity.identityKey && (!projectId || f.projectId === projectId))
      .map((f) => ({
        id: f.id,
        project_id: f.projectId,
        filename: f.filename,
        language: f.language,
        size: f.size,
        updated_at: f.updatedAt,
      }));
    res.json({ files });
  });

  router.post('/projects/files', (req, res) => {
    const identity = resolveIdentity(req);
    const body = (req.body || {}) as {
      id?: string;
      project_id?: string;
      filename?: string;
      language?: string;
      content?: string;
    };
    const id = body.id?.replace(/[^A-Za-z0-9_-]/g, '') || createUuid().replace(/-/g, '');
    const content = typeof body.content === 'string' ? body.content : '';
    const now = new Date().toISOString();
    const record = {
      id,
      identityKey: identity.identityKey,
      projectId: String(body.project_id || ''),
      filename: String(body.filename || 'untitled.txt').slice(0, 255),
      language: String(body.language || 'text').slice(0, 40),
      content,
      size: Buffer.byteLength(content, 'utf8'),
      createdAt: store.projectFiles.get(id)?.createdAt || now,
      updatedAt: now,
    };
    store.projectFiles.set(id, record);
    res.json({
      file: {
        id: record.id,
        project_id: record.projectId,
        filename: record.filename,
        language: record.language,
        size: record.size,
        content: record.content,
        updated_at: record.updatedAt,
      },
    });
  });

  router.get('/projects/files/:id', (req, res) => {
    const identity = resolveIdentity(req);
    const file = store.projectFiles.get(req.params.id);
    if (!file || file.identityKey !== identity.identityKey) {
      res.status(404).json({ code: 'not_found', message: 'File not found.' });
      return;
    }
    res.json({
      file: {
        id: file.id,
        project_id: file.projectId,
        filename: file.filename,
        language: file.language,
        size: file.size,
        content: file.content,
        updated_at: file.updatedAt,
      },
    });
  });

  router.delete('/projects/files/:id', (req, res) => {
    const identity = resolveIdentity(req);
    const file = store.projectFiles.get(req.params.id);
    if (!file || file.identityKey !== identity.identityKey) {
      res.status(404).json({ code: 'not_found', message: 'File not found.' });
      return;
    }
    store.projectFiles.delete(req.params.id);
    res.json({ deleted: true, id: req.params.id });
  });

  // 9. API Keys & Usage Dashboard
  router.get('/api-keys', (req, res) => {
    const guest = getGuestToken(req);
    const login = guest ? store.githubVerified.get(guest)?.login || '' : '';
    const keys = [...store.apiKeys.values()]
      .filter((k) => (guest && k.guestToken === guest) || (login && k.githubLogin === login))
      .sort((a, b) => b.id - a.id)
      .map((k) => ({
        id: k.id,
        key_prefix: k.keyPrefix,
        name: k.name,
        github_login: k.githubLogin,
        created_at: k.createdAt,
        last_used_at: k.lastUsedAt,
        revoked_at: k.revokedAt,
      }));
    res.json({ verified: true, keys });
  });

  router.post('/api-keys', (req, res) => {
    const guest = getGuestToken(req) || 'anonymous';
    const login = store.githubVerified.get(guest)?.login || '';
    const name = String((req.body as { name?: string })?.name || 'API Key').slice(0, 80);
    const { record, rawKey } = store.createApiKey(name, guest, login);
    res.status(201).json({
      key: rawKey,
      record: {
        id: record.id,
        key_prefix: record.keyPrefix,
        name: record.name,
        created_at: record.createdAt,
      },
    });
  });

  router.delete('/api-keys/:id', (req, res) => {
    const id = Number(req.params.id);
    const rec = store.apiKeys.get(id);
    if (!rec) {
      res.status(404).json({ code: 'not_found', message: 'API key not found.' });
      return;
    }
    rec.revokedAt = new Date().toISOString();
    res.json({ revoked: true, id });
  });

  router.get('/api-usage', (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const guest = getGuestToken(req);
    const keys = [...store.apiKeys.values()].filter((k) => !guest || k.guestToken === guest);

    const now = Date.now();
    const dayMap = new Map<string, number>();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
      dayMap.set(d, 0);
    }

    let requests = 0;
    let tokens = 0;
    let failures = 0;
    let latencySum = 0;

    for (const ev of store.apiUsageEvents) {
      const day = new Date(ev.timestamp).toISOString().slice(0, 10);
      if (dayMap.has(day)) {
        dayMap.set(day, (dayMap.get(day) || 0) + 1);
      }
      if (ev.success) requests += 1;
      else failures += 1;
      tokens += ev.tokens;
      latencySum += ev.latencyMs;
    }

    const totalCalls = requests + failures;
    res.json({
      period_days: days,
      summary: {
        requests,
        tokens,
        failures,
        avg_latency_ms: totalCalls > 0 ? Math.round(latencySum / totalCalls) : 0,
      },
      limits: {
        requests_per_minute: RATE_LIMIT_PER_MINUTE,
        requests_per_day: 'Depends on provider',
        tokens_per_hour: TOKEN_QUOTA_LIMIT,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        retention_days: 90,
      },
      series: [...dayMap.entries()].map(([date, count]) => ({ date, requests: count })),
      has_api_keys: keys.length > 0,
      keys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        key_prefix: k.keyPrefix,
        last_used_at: k.lastUsedAt,
      })),
    });
  });

  router.get('/api-models', (_req, res) => {
    const models = Object.values(MODELS).map((m) => ({
      id: m.id,
      name: m.label,
      provider: m.provider,
      provider_model: m.apiModel,
      supports_images: m.supportsImages,
      supports_tools: m.supportsTools,
      logo: m.logo,
    }));
    res.json({ models });
  });

  // 10. OpenAI-compatible API (/models, /chat/completions, /responses)
  router.get('/models', (_req, res) => {
    res.json({
      object: 'list',
      data: Object.values(MODELS).map((m) => ({
        id: m.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: m.provider,
      })),
    });
  });

  router.post('/chat/completions', async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const rawMessages = Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : [];
    if (rawMessages.length === 0) {
      res.status(400).json({ error: { message: 'messages array is required.' } });
      return;
    }
    const requestedModel = typeof body.model === 'string' && MODELS[body.model] ? body.model : DEFAULT_MODEL;
    const keyInfo = getApiKeyForModel(requestedModel);
    if ('error' in keyInfo) {
      res.status(keyInfo.status).json({ error: { message: keyInfo.error } });
      return;
    }
    const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : null;
    const result = await callChatApi(rawMessages, keyInfo.apiModel, keyInfo.key, keyInfo.url, null, maxTokens);
    if ('error' in result) {
      res.status(result.status).json({ error: { message: result.error } });
      return;
    }
    const id = `chatcmpl-${createUuid().replace(/-/g, '')}`;
    const created = Math.floor(Date.now() / 1000);
    if (body.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      const chunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: requestedModel,
        choices: [{ index: 0, delta: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.json({
      id,
      object: 'chat.completion',
      created,
      model: requestedModel,
      choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
      usage: result.usage,
    });
  });

  router.post('/responses', async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const input = typeof body.input === 'string' ? body.input : JSON.stringify(body.input || '');
    const instructions = typeof body.instructions === 'string' ? body.instructions : '';
    const messages: ChatMessage[] = [];
    if (instructions) messages.push({ role: 'system', content: instructions });
    messages.push({ role: 'user', content: input });
    const requestedModel = typeof body.model === 'string' && MODELS[body.model] ? body.model : DEFAULT_MODEL;
    const keyInfo = getApiKeyForModel(requestedModel);
    if ('error' in keyInfo) {
      res.status(keyInfo.status).json({ error: { message: keyInfo.error } });
      return;
    }
    const result = await callChatApi(messages, keyInfo.apiModel, keyInfo.key, keyInfo.url);
    if ('error' in result) {
      res.status(result.status).json({ error: { message: result.error } });
      return;
    }
    const suffix = createUuid().replace(/-/g, '');
    res.json({
      id: `resp_${suffix}`,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      model: requestedModel,
      output: [
        {
          id: `msg_${suffix}`,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: result.text, annotations: [] }],
        },
      ],
      usage: result.usage,
    });
  });

  // 11. MCP Servers
  router.get('/mcp/servers', (req, res) => {
    const identity = resolveIdentity(req);
    const list = (store.mcpServers.get(identity.identityKey) || []).map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      has_token: s.hasToken,
      tools: s.tools,
      created_at: s.createdAt,
      updated_at: s.updatedAt,
    }));
    res.json({ servers: list });
  });

  router.post('/mcp/servers', async (req, res) => {
    const identity = resolveIdentity(req);
    const body = (req.body || {}) as { name?: string; url?: string; token?: string };
    const name = String(body.name || '').trim().slice(0, 80);
    const url = String(body.url || '').trim();
    const token = String(body.token || '').trim();
    if (!name || !/^https?:\/\/.+/i.test(url)) {
      res.status(400).json({ code: 'mcp_invalid', message: 'A valid server name and http(s) URL are required.' });
      return;
    }

    const init = await mcpRpcCall(url, token, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'Ptero-AI-Chat', version: '1.26.4' },
    });
    if (init.error) {
      res.status(502).json({ code: 'mcp_connect_failed', message: init.error });
      return;
    }
    const toolsRpc = await mcpRpcCall(url, token, 'tools/list', {}, init.sessionId);
    const rawTools = Array.isArray(toolsRpc.result?.tools)
      ? (toolsRpc.result!.tools as Array<Record<string, unknown>>)
      : [];

    const now = new Date().toISOString();
    const server = {
      id: createUuid(),
      name,
      url,
      encryptedToken: store.encryptSecret(token),
      hasToken: Boolean(token),
      sessionId: toolsRpc.sessionId || init.sessionId || '',
      protocolVersion: '2024-11-05',
      tools: rawTools.slice(0, 100).map((t) => ({
        name: String(t.name || ''),
        description: String(t.description || ''),
        inputSchema: (t.inputSchema as Record<string, unknown>) || {},
        enabled: false,
      })),
      createdAt: now,
      updatedAt: now,
    };

    const existing = store.mcpServers.get(identity.identityKey) || [];
    existing.push(server);
    store.mcpServers.set(identity.identityKey, existing);

    res.status(201).json({
      server: {
        id: server.id,
        name: server.name,
        url: server.url,
        has_token: server.hasToken,
        tools: server.tools,
      },
    });
  });

  router.delete('/mcp/servers/:id', (req, res) => {
    const identity = resolveIdentity(req);
    const existing = store.mcpServers.get(identity.identityKey) || [];
    const next = existing.filter((s) => s.id !== req.params.id);
    if (next.length === existing.length) {
      res.status(404).json({ code: 'mcp_not_found', message: 'MCP server not found.' });
      return;
    }
    store.mcpServers.set(identity.identityKey, next);
    res.json({ deleted: true, id: req.params.id });
  });

  router.post('/mcp/servers/:id/refresh', async (req, res) => {
    const identity = resolveIdentity(req);
    const list = store.mcpServers.get(identity.identityKey) || [];
    const server = list.find((s) => s.id === req.params.id);
    if (!server) {
      res.status(404).json({ code: 'mcp_not_found', message: 'MCP server not found.' });
      return;
    }
    const token = store.decryptSecret(server.encryptedToken);
    const toolsRpc = await mcpRpcCall(server.url, token, 'tools/list', {}, server.sessionId);
    if (toolsRpc.error) {
      res.status(502).json({ code: 'mcp_refresh_failed', message: toolsRpc.error });
      return;
    }
    const enabledSet = new Set(server.tools.filter((t) => t.enabled).map((t) => t.name));
    const rawTools = Array.isArray(toolsRpc.result?.tools)
      ? (toolsRpc.result!.tools as Array<Record<string, unknown>>)
      : [];
    server.tools = rawTools.slice(0, 100).map((t) => {
      const name = String(t.name || '');
      return {
        name,
        description: String(t.description || ''),
        inputSchema: (t.inputSchema as Record<string, unknown>) || {},
        enabled: enabledSet.has(name),
      };
    });
    server.updatedAt = new Date().toISOString();
    res.json({
      server: {
        id: server.id,
        name: server.name,
        url: server.url,
        has_token: server.hasToken,
        tools: server.tools,
      },
    });
  });

  router.post('/mcp/servers/:id/tools', (req, res) => {
    const identity = resolveIdentity(req);
    const list = store.mcpServers.get(identity.identityKey) || [];
    const server = list.find((s) => s.id === req.params.id);
    if (!server) {
      res.status(404).json({ code: 'mcp_not_found', message: 'MCP server not found.' });
      return;
    }
    const enabled = new Set(
      Array.isArray((req.body as { enabled?: unknown[] })?.enabled)
        ? ((req.body as { enabled: unknown[] }).enabled as string[])
        : []
    );
    for (const tool of server.tools) {
      tool.enabled = enabled.has(tool.name);
    }
    server.updatedAt = new Date().toISOString();
    res.json({
      server: {
        id: server.id,
        name: server.name,
        url: server.url,
        has_token: server.hasToken,
        tools: server.tools,
      },
    });
  });

  router.post('/mcp/servers/:id/call', async (req, res) => {
    const identity = resolveIdentity(req);
    const list = store.mcpServers.get(identity.identityKey) || [];
    const server = list.find((s) => s.id === req.params.id);
    if (!server) {
      res.status(404).json({ code: 'mcp_not_found', message: 'MCP server not found.' });
      return;
    }
    const body = (req.body || {}) as { name?: string; arguments?: Record<string, unknown> };
    const tool = server.tools.find((t) => t.name === body.name);
    if (!tool || !tool.enabled) {
      res.status(403).json({ code: 'mcp_tool_disabled', message: 'Enable and save this tool before running it.' });
      return;
    }
    const token = store.decryptSecret(server.encryptedToken);
    const rpc = await mcpRpcCall(
      server.url,
      token,
      'tools/call',
      { name: tool.name, arguments: body.arguments || {} },
      server.sessionId
    );
    if (rpc.error) {
      res.status(502).json({ code: 'mcp_call_failed', message: rpc.error });
      return;
    }
    res.json({
      isError: Boolean(rpc.result?.isError),
      text: extractMcpToolText(rpc.result || {}),
      result: rpc.result,
    });
  });

  // 12. Referrals
  router.get('/referrals', (req, res) => {
    const identity = resolveIdentity(req);
    const code = store.getOrCreateReferralCode(identity.identityKey);
    const origin = `${req.protocol}://${req.get('host')}`;
    const invited = store.referralRecords.filter((r) => r.referrerIdentity === identity.identityKey);
    const incoming = store.referralRecords.filter((r) => r.referredIdentity === identity.identityKey);
    const earnedTokens =
      invited.reduce((acc, r) => acc + r.reward, 0) + incoming.reduce((acc, r) => acc + r.reward, 0);

    res.json({
      link: `${origin}/?ref=${code}`,
      referrals: invited.length,
      earned_tokens: earnedTokens,
      bonus_tokens: earnedTokens,
      referral_users: invited.map((r) => ({ id: r.id, label: r.label, reward: r.reward })),
      incoming_referrals: incoming.map((r) => ({ id: r.id, label: r.label, reward: r.reward })),
    });
  });

  router.post('/referrals/:id/claim', (_req, res) => {
    res.json({ claimed: true, tokens: 0, quota_updated: false });
  });

  router.post('/referrals/claim-earned', (_req, res) => {
    res.json({ claimed: true, tokens: 0, quota_updated: false });
  });

  // 13. Cloudflare Turnstile verification
  router.post('/verify-turnstile', async (req, res) => {
    const token = String((req.body as { token?: string })?.token || '');
    if (!token) {
      res.json({ success: false, error: 'missing_token' });
      return;
    }
    const secret = process.env.MLP_TURNSTILE_SECRET_KEY?.trim();
    if (!secret) {
      res.json({ success: false, error: 'not_configured' });
      return;
    }
    try {
      const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret, response: token }),
      });
      const data = (await resp.json()) as { success?: boolean };
      res.json({ success: Boolean(data.success) });
    } catch {
      res.json({ success: false, error: 'verify_request_failed' });
    }
  });

  return router;
}
