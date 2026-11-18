import AdmZip from 'adm-zip';
import crypto from 'node:crypto';
import {
  ARCHIVE_MAX_FILE_BYTES,
  ARCHIVE_MAX_FILES,
  ARCHIVE_MAX_TEXT_CHARS,
  ARCHIVE_MAX_UNPACKED_BYTES,
  CODE_CHUNK_MAX_CHARS,
  CODE_CHUNK_MAX_LINES,
  CODE_MAX_CHUNKS,
  CODE_MAX_CONTEXT_CHARS,
  CODE_MAX_FILES,
  COMPLEX_HISTORY_CHARS,
  COMPLEX_OUTPUT_TOKENS,
  DEFAULT_MODEL,
  FAST_HISTORY_CHARS,
  FAST_OUTPUT_TOKENS,
  LANGUAGES,
  MAX_HISTORY_CHARS,
  MAX_OUTPUT_TOKENS,
  MERCURY_MAX_OUTPUT_TOKENS,
  MODE_INSTRUCTIONS,
  MODELS,
  PROVIDER_TIMEOUT_MS,
  QUICK_HISTORY_CHARS,
  QUICK_OUTPUT_TOKENS,
  WEBCLAW_API_URL,
} from './config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface Attachment {
  name: string;
  type: string;
  data: string;
  size?: number;
}

export interface StreamEventPayload {
  phase?: string;
  activity?: { type: string; label: string };
  thinking?: string;
  token?: string;
  tool_call_delta?: unknown;
  model?: string;
  done?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface ChatStreamResult {
  text: string;
  thinking: string;
  usageTokens: number;
  finishReason: string;
  error: string;
  httpCode: number;
  toolCalls: ToolCall[];
}

export interface ChatCallResult {
  text: string;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  finishReason: string;
  toolCalls?: ToolCall[];
}

interface ModelInternalConfig {
  supportsTemperature: boolean;
  maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  maxOutputTokens: number | null;
  reasoningEffort: string | null;
  contextLimit: number;
}

function getModelInternalConfig(model: string): ModelInternalConfig {
  const configs: Record<string, Partial<ModelInternalConfig>> = {
    'mercury-2': {
      reasoningEffort: 'instant',
      maxOutputTokens: MERCURY_MAX_OUTPUT_TOKENS,
      contextLimit: 32000,
    },
    o1: {
      supportsTemperature: false,
      maxTokensParam: 'max_completion_tokens',
      contextLimit: 200000,
    },
    o3: {
      supportsTemperature: false,
      maxTokensParam: 'max_completion_tokens',
      contextLimit: 200000,
    },
    'o3-mini': {
      supportsTemperature: false,
      maxTokensParam: 'max_completion_tokens',
      contextLimit: 200000,
    },
  };
  const defaults: ModelInternalConfig = {
    supportsTemperature: true,
    maxTokensParam: 'max_tokens',
    maxOutputTokens: null,
    reasoningEffort: null,
    contextLimit: 128000,
  };
  return { ...defaults, ...(configs[model] || {}) };
}

export function looksTruncatedMidCode(text: string): boolean {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  const matches = trimmed.match(/```/g);
  return (matches ? matches.length : 0) % 2 === 1;
}

function estimateTokens(content: unknown): number {
  const str = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  return Math.ceil(str.length / 4);
}

function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content) + 4;
  }
  return total;
}

function fitMessagesToContext(messages: ChatMessage[], model: string, maxTokens?: number | null): ChatMessage[] {
  const cfg = getModelInternalConfig(model);
  const reserve = maxTokens ? Math.max(1, maxTokens) : MAX_OUTPUT_TOKENS;
  const budget = cfg.contextLimit - reserve;
  if (budget <= 0 || estimateMessagesTokens(messages) <= budget) {
    return messages;
  }
  const system: ChatMessage[] = [];
  const rest: ChatMessage[] = [];
  for (const msg of messages) {
    if (rest.length === 0 && msg.role === 'system') {
      system.push(msg);
    } else {
      rest.push(msg);
    }
  }
  let used = estimateMessagesTokens(system);
  const kept: ChatMessage[] = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const tokens = estimateMessagesTokens([rest[i]]);
    if (used + tokens > budget && kept.length > 0) {
      break;
    }
    used += tokens;
    kept.unshift(rest[i]);
  }
  return [...system, ...kept];
}

function buildRequestBody(
  messages: ChatMessage[],
  model: string,
  maxTokens?: number | null,
  stream = false,
  tools?: unknown[] | null,
  sampling: Record<string, number | undefined> = {}
): Record<string, unknown> {
  const cfg = getModelInternalConfig(model);
  let resolvedMax = maxTokens ? Math.max(1, maxTokens) : MAX_OUTPUT_TOKENS;
  if (cfg.maxOutputTokens) {
    resolvedMax = Math.min(resolvedMax, cfg.maxOutputTokens);
  }
  const body: Record<string, unknown> = {
    model,
    messages,
    stream,
    [cfg.maxTokensParam]: resolvedMax,
  };
  if (cfg.supportsTemperature && sampling) {
    if (typeof sampling.temperature === 'number') {
      body.temperature = Math.max(0, Math.min(2, sampling.temperature));
    }
    if (typeof sampling.top_p === 'number') {
      body.top_p = Math.max(0, Math.min(1, sampling.top_p));
    }
    if (typeof sampling.presence_penalty === 'number') {
      body.presence_penalty = Math.max(-2, Math.min(2, sampling.presence_penalty));
    }
    if (typeof sampling.frequency_penalty === 'number') {
      body.frequency_penalty = Math.max(-2, Math.min(2, sampling.frequency_penalty));
    }
  }
  if (cfg.reasoningEffort) {
    body.reasoning_effort = cfg.reasoningEffort;
  }
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  return body;
}

function extractChatContent(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const choices = (data as { choices?: unknown[] }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0] as Record<string, unknown>;
  const msg = (choice.message as Record<string, unknown>) || {};
  const delta = (choice.delta as Record<string, unknown>) || {};
  const raw = msg.content ?? choice.text ?? delta.content ?? null;

  if (typeof raw === 'string' && raw.trim() !== '') {
    return raw;
  }
  if (Array.isArray(raw)) {
    let text = '';
    for (const part of raw) {
      if (typeof part === 'string') text += part;
      else if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
        text += (part as { text: string }).text;
      }
    }
    if (text.trim() !== '') return text;
  }
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim() !== '') {
    return msg.reasoning_content;
  }
  return null;
}

async function singleChatRequest(
  messages: ChatMessage[],
  model: string,
  apiKey: string,
  apiUrl: string,
  tools?: unknown[] | null,
  maxTokens?: number | null,
  sampling: Record<string, number | undefined> = {},
  retryAttempts = 3
): Promise<ChatCallResult | { error: string; status: number }> {
  const fitted = fitMessagesToContext(messages, model, maxTokens);
  const body = buildRequestBody(fitted, model, maxTokens, false, tools, sampling);

  let delayMs = 1000;
  let lastResp: Response | null = null;

  for (let attempt = 1; attempt <= retryAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      lastResp = resp;

      if ((resp.status === 429 || resp.status >= 500) && attempt < retryAttempts) {
        const retryAfter = Number(resp.headers.get('retry-after') || '0');
        const wait = retryAfter > 0 ? retryAfter * 1000 : delayMs;
        await new Promise((r) => setTimeout(r, wait));
        delayMs *= 2;
        continue;
      }
      break;
    } catch (err) {
      if (attempt >= retryAttempts) {
        return {
          error: `Could not reach the API: ${err instanceof Error ? err.message : String(err)}`,
          status: 500,
        };
      }
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs *= 2;
    }
  }

  if (!lastResp) {
    return { error: 'No response from AI provider.', status: 502 };
  }

  const rawText = await lastResp.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    parsed = null;
  }

  if (!lastResp.ok) {
    const errObj = parsed?.error as { message?: string } | undefined;
    const msg =
      errObj?.message ||
      (typeof parsed?.message === 'string' ? parsed.message : '') ||
      `Unknown API error (HTTP ${lastResp.status}).`;
    return { error: msg, status: lastResp.status || 502 };
  }

  const choices = Array.isArray(parsed?.choices) ? (parsed!.choices as Record<string, unknown>[]) : [];
  const firstChoice = choices[0] || {};
  const msg = (firstChoice.message as Record<string, unknown>) || {};

  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    return {
      text: typeof msg.content === 'string' ? msg.content : '',
      toolCalls: msg.tool_calls as ToolCall[],
      usage: (parsed?.usage as ChatCallResult['usage']) || {},
      finishReason: typeof firstChoice.finish_reason === 'string' ? firstChoice.finish_reason : '',
    };
  }

  const content = extractChatContent(parsed);
  if (content !== null) {
    return {
      text: content,
      usage: (parsed?.usage as ChatCallResult['usage']) || {},
      finishReason: typeof firstChoice.finish_reason === 'string' ? firstChoice.finish_reason : '',
    };
  }

  return {
    error: `Unexpected response format from the API. Response: ${rawText.slice(0, 300)}`,
    status: 502,
  };
}

export async function callChatApi(
  messages: ChatMessage[],
  model: string,
  apiKey: string,
  apiUrl: string,
  tools?: unknown[] | null,
  maxTokens?: number | null,
  sampling: Record<string, number | undefined> = {},
  retryAttempts = 3,
  maxContinuations = 6
): Promise<ChatCallResult | { error: string; status: number }> {
  const workingMessages = [...messages];
  let accumulatedText = '';
  const accumulatedUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  let continuations = 0;
  let lastFinishReason = '';

  while (true) {
    const res = await singleChatRequest(
      workingMessages,
      model,
      apiKey,
      apiUrl,
      tools,
      maxTokens,
      sampling,
      retryAttempts
    );
    if ('error' in res) {
      if (accumulatedText !== '') break;
      return res;
    }
    if (res.toolCalls && res.toolCalls.length > 0) {
      return res;
    }
    accumulatedText += res.text;
    accumulatedUsage.prompt_tokens += res.usage.prompt_tokens || 0;
    accumulatedUsage.completion_tokens += res.usage.completion_tokens || 0;
    accumulatedUsage.total_tokens += res.usage.total_tokens || 0;
    lastFinishReason = res.finishReason;

    const wasTruncated =
      res.text.trim() !== '' && (res.finishReason === 'length' || looksTruncatedMidCode(res.text));
    if (!wasTruncated || continuations >= maxContinuations) {
      break;
    }
    continuations += 1;
    workingMessages.push({ role: 'assistant', content: res.text });
    workingMessages.push({
      role: 'user',
      content:
        'Continue exactly where you left off. Do not repeat any earlier text and do not add commentary about continuing — just resume the output.',
    });
  }

  return {
    text: accumulatedText,
    usage: accumulatedUsage,
    finishReason: lastFinishReason,
  };
}

async function singleStreamAttempt(
  messages: ChatMessage[],
  model: string,
  apiKey: string,
  apiUrl: string,
  maxTokens: number | null,
  emitEvent?: (payload: StreamEventPayload) => void,
  emitKeepalive?: () => void,
  tools?: unknown[] | null,
  sampling: Record<string, number | undefined> = {}
): Promise<ChatStreamResult> {
  const fitted = fitMessagesToContext(messages, model, maxTokens);
  const body = buildRequestBody(fitted, model, maxTokens, true, tools, sampling);

  let fullText = '';
  let thinkingText = '';
  let finishReason = '';
  let usageTokens = 0;
  const toolCallsAcc = new Map<number, ToolCall>();

  let outContentBuffer = '';
  let outThinkingBuffer = '';
  let activityBuffer = '';
  let narrationBuffer = '';
  let lastFlush = Date.now();

  const emit = emitEvent || (() => {});
  const emitNarration = (line: string) => {
    const trimmed = line.trim();
    const match = trimmed.match(/^(THINK|READ|EDIT|CHECK):\s*(.+)$/i);
    if (!match) return;
    const map: Record<string, string> = {
      THINK: 'thinking',
      READ: 'reading',
      EDIT: 'editing',
      CHECK: 'checking',
    };
    emit({
      activity: {
        type: map[match[1].toUpperCase()] || 'thinking',
        label: match[2].trim(),
      },
    });
  };

  const flushBuffers = (force = false) => {
    const due =
      force ||
      Date.now() - lastFlush >= 40 ||
      outContentBuffer.length >= 24 ||
      outThinkingBuffer.length >= 24;
    if (!due) return;
    if (outThinkingBuffer) {
      emit({ thinking: outThinkingBuffer });
      outThinkingBuffer = '';
    }
    if (outContentBuffer) {
      emit({ token: outContentBuffer });
      outContentBuffer = '';
    }
    lastFlush = Date.now();
  };

  if (emitKeepalive) emitKeepalive();

  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    if (emitKeepalive) emitKeepalive();
  }, 15_000);

  const idleTimeout = setTimeout(() => controller.abort(), 180_000);

  try {
    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const httpCode = resp.status;
    if (!resp.ok || !resp.body) {
      const errText = await resp.text().catch(() => '');
      return {
        text: '',
        thinking: '',
        usageTokens: 0,
        finishReason: '',
        error: errText || `HTTP ${httpCode}`,
        httpCode,
        toolCalls: [],
      };
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      idleTimeout.refresh();
      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const jsonStr = line.slice(5).trimStart();
        if (jsonStr === '[DONE]') continue;
        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(jsonStr) as Record<string, unknown>;
        } catch {
          continue;
        }
        const usage = chunk.usage as { total_tokens?: number } | undefined;
        if (usage?.total_tokens) {
          usageTokens = Number(usage.total_tokens) || usageTokens;
        }
        const choices = Array.isArray(chunk.choices) ? (chunk.choices as Record<string, unknown>[]) : [];
        const choice0 = choices[0] || {};
        if (typeof choice0.finish_reason === 'string' && choice0.finish_reason) {
          finishReason = choice0.finish_reason;
        }
        const delta = (choice0.delta as Record<string, unknown>) || {};

        const thinkingToken = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
        if (thinkingToken) {
          thinkingText += thinkingToken;
          activityBuffer += thinkingToken;
          outThinkingBuffer += thinkingToken;
          const actLines = activityBuffer.split(/\r?\n/);
          activityBuffer = actLines.pop() || '';
          for (const actLine of actLines) {
            const t = actLine.trim();
            if (!t) continue;
            let type = 'thinking';
            if (/^READ:\s*/i.test(t)) type = 'reading';
            else if (/^EDIT:\s*/i.test(t)) type = 'editing';
            else if (/^CHECK:\s*/i.test(t)) type = 'checking';
            emit({
              activity: {
                type,
                label: t.replace(/^(THINK|READ|EDIT|CHECK):\s*/i, ''),
              },
            });
          }
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
            const idx = Number(tc.index ?? 0);
            if (!toolCallsAcc.has(idx)) {
              toolCallsAcc.set(idx, {
                id: '',
                type: 'function',
                function: { name: '', arguments: '' },
              });
            }
            const cur = toolCallsAcc.get(idx)!;
            if (typeof tc.id === 'string') cur.id = tc.id;
            const fn = tc.function as { name?: string; arguments?: string } | undefined;
            if (fn?.name) cur.function.name += fn.name;
            if (fn?.arguments) cur.function.arguments += fn.arguments;
          }
          emit({ tool_call_delta: delta.tool_calls });
        }

        const token = typeof delta.content === 'string' ? delta.content : '';
        if (token) {
          fullText += token;
          narrationBuffer += token;
          const narrLines = narrationBuffer.split(/\r?\n/);
          narrationBuffer = narrLines.pop() || '';
          for (const nl of narrLines) emitNarration(nl);
          outContentBuffer += token;
        }

        flushBuffers(false);
      }
      flushBuffers(false);
    }

    flushBuffers(true);
    if (narrationBuffer.trim()) emitNarration(narrationBuffer);

    return {
      text: fullText,
      thinking: thinkingText,
      usageTokens,
      finishReason,
      error: '',
      httpCode,
      toolCalls: [...toolCallsAcc.values()],
    };
  } catch (err) {
    flushBuffers(true);
    return {
      text: fullText,
      thinking: thinkingText,
      usageTokens,
      finishReason,
      error: err instanceof Error ? err.message : 'Stream connection failed.',
      httpCode: 0,
      toolCalls: [...toolCallsAcc.values()],
    };
  } finally {
    clearInterval(heartbeat);
    clearTimeout(idleTimeout);
  }
}

export async function streamChatApi(
  messages: ChatMessage[],
  model: string,
  apiKey: string,
  apiUrl: string,
  maxTokens: number | null,
  emitEvent?: (payload: StreamEventPayload) => void,
  emitKeepalive?: () => void,
  tools?: unknown[] | null,
  sampling: Record<string, number | undefined> = {},
  maxContinuations = 6
): Promise<ChatStreamResult> {
  const workingMessages = [...messages];
  let combinedText = '';
  let combinedThinking = '';
  let combinedUsage = 0;
  let continuations = 0;
  let lastResult: ChatStreamResult | null = null;

  while (true) {
    const res = await singleStreamAttempt(
      workingMessages,
      model,
      apiKey,
      apiUrl,
      maxTokens,
      emitEvent,
      emitKeepalive,
      tools,
      sampling
    );
    lastResult = res;
    combinedText += res.text;
    combinedThinking += res.thinking;
    combinedUsage += res.usageTokens;

    const wasTruncated =
      res.error === '' &&
      res.httpCode >= 200 &&
      res.httpCode < 300 &&
      res.toolCalls.length === 0 &&
      res.text.trim() !== '' &&
      (res.finishReason === 'length' || looksTruncatedMidCode(res.text));

    if (!wasTruncated || continuations >= maxContinuations) {
      break;
    }
    continuations += 1;
    workingMessages.push({ role: 'assistant', content: res.text });
    workingMessages.push({
      role: 'user',
      content:
        'Continue exactly where you left off. Do not repeat any earlier text and do not add commentary about continuing — just resume the output.',
    });
  }

  return {
    text: combinedText,
    thinking: combinedThinking,
    usageTokens: combinedUsage,
    finishReason: lastResult?.finishReason || '',
    error: lastResult?.error || '',
    httpCode: lastResult?.httpCode || 0,
    toolCalls: lastResult?.toolCalls || [],
  };
}

export async function runAgenticTurn(
  messages: ChatMessage[],
  model: string,
  apiKey: string,
  apiUrl: string,
  tools: unknown[] | null,
  toolDispatcher: (name: string, args: Record<string, unknown>) => Promise<string>,
  options: { maxTokens?: number | null; sampling?: Record<string, number | undefined>; maxIterations?: number } = {}
): Promise<{ text: string; usage: ChatCallResult['usage']; messages: ChatMessage[] } | { error: string; status: number }> {
  const workingMessages = [...messages];
  const maxIterations = Math.max(1, options.maxIterations ?? 5);
  const totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  for (let i = 0; i < maxIterations; i++) {
    const res = await callChatApi(
      workingMessages,
      model,
      apiKey,
      apiUrl,
      tools,
      options.maxTokens,
      options.sampling
    );
    if ('error' in res) return res;

    totalUsage.prompt_tokens += res.usage.prompt_tokens || 0;
    totalUsage.completion_tokens += res.usage.completion_tokens || 0;
    totalUsage.total_tokens += res.usage.total_tokens || 0;

    if (!res.toolCalls || res.toolCalls.length === 0) {
      return { text: res.text, usage: totalUsage, messages: workingMessages };
    }

    workingMessages.push({
      role: 'assistant',
      content: res.text,
      tool_calls: res.toolCalls,
    });

    for (const tc of res.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      const output = await toolDispatcher(tc.function.name, args);
      workingMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: output,
      });
    }
  }

  return {
    error: 'The AI made too many consecutive tool calls without producing a final answer.',
    status: 502,
  };
}

export async function streamAgenticTurn(
  messages: ChatMessage[],
  model: string,
  apiKey: string,
  apiUrl: string,
  tools: unknown[] | null,
  toolDispatcher: (name: string, args: Record<string, unknown>) => Promise<string>,
  emitEvent?: (payload: StreamEventPayload) => void,
  emitKeepalive?: () => void,
  options: {
    maxTokens?: number | null;
    sampling?: Record<string, number | undefined>;
    maxIterations?: number;
    onToolCall?: (name: string, args: Record<string, unknown>) => void;
  } = {}
): Promise<ChatStreamResult> {
  const workingMessages = [...messages];
  const maxIterations = Math.max(1, options.maxIterations ?? 5);
  let allText = '';
  let allThinking = '';
  let totalUsage = 0;
  let lastResult: ChatStreamResult | null = null;

  for (let i = 0; i < maxIterations; i++) {
    const res = await streamChatApi(
      workingMessages,
      model,
      apiKey,
      apiUrl,
      options.maxTokens ?? null,
      emitEvent,
      emitKeepalive,
      tools,
      options.sampling
    );
    lastResult = res;
    allText += res.text;
    allThinking += res.thinking;
    totalUsage += res.usageTokens;

    if (res.error !== '' || res.httpCode < 200 || res.httpCode >= 300) {
      break;
    }
    if (!res.toolCalls || res.toolCalls.length === 0) {
      break;
    }

    workingMessages.push({
      role: 'assistant',
      content: res.text,
      tool_calls: res.toolCalls,
    });

    for (const tc of res.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      if (options.onToolCall) options.onToolCall(tc.function.name, args);
      const output = await toolDispatcher(tc.function.name, args);
      workingMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: output,
      });
    }
  }

  if (!lastResult) {
    return {
      text: '',
      thinking: '',
      usageTokens: 0,
      finishReason: '',
      error: 'The AI stream did not return a response.',
      httpCode: 502,
      toolCalls: [],
    };
  }

  const finalError =
    lastResult.toolCalls.length === 0 && allText.trim() === '' && lastResult.error === ''
      ? 'The provider ended the stream without a final answer.'
      : lastResult.error;

  return {
    ...lastResult,
    text: allText,
    thinking: allThinking,
    usageTokens: totalUsage,
    error: finalError,
  };
}

// ---------------------------------------------------------------------------
// Chat Helpers: Mode normalization, Attachment extraction, GitHub tools
// ---------------------------------------------------------------------------

export function normalizeChatMode(requestedMode: string, message: string, attachments: Attachment[]): string {
  const mode = (requestedMode || 'fast').toLowerCase();
  if (mode === 'quick' || mode === 'fast' || mode === 'complex' || mode === 'full') {
    return mode;
  }
  if (mode === 'smart') {
    const trimmed = message.trim();
    if (attachments.length === 0 && trimmed.length <= 24 && !/[{}\[\]<>`]/.test(trimmed)) {
      return 'quick';
    }
    return 'fast';
  }
  return 'fast';
}

export function getChatHistoryLimit(mode: string): number {
  switch (mode) {
    case 'quick':
      return QUICK_HISTORY_CHARS;
    case 'complex':
      return COMPLEX_HISTORY_CHARS;
    case 'full':
      return MAX_HISTORY_CHARS;
    default:
      return FAST_HISTORY_CHARS;
  }
}

export function getChatOutputTokens(mode: string): number {
  switch (mode) {
    case 'quick':
      return QUICK_OUTPUT_TOKENS;
    case 'complex':
      return COMPLEX_OUTPUT_TOKENS;
    case 'full':
      return MAX_OUTPUT_TOKENS;
    default:
      return FAST_OUTPUT_TOKENS;
  }
}

export function getCandidateModels(requestedModel: string): string[] {
  const keys = Object.keys(MODELS);
  const sanitized = MODELS[requestedModel] ? requestedModel : DEFAULT_MODEL;
  return [sanitized, ...keys.filter((k) => k !== sanitized)];
}

export function sanitizeAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];
  const clean: Attachment[] = [];
  for (const item of raw.slice(0, 4)) {
    if (!item || typeof item !== 'object') continue;
    const att = item as Record<string, unknown>;
    const data = typeof att.data === 'string' ? att.data : '';
    if (!data || data.length > 24 * 1024 * 1024) continue;
    clean.push({
      name: typeof att.name === 'string' ? att.name.slice(0, 255) : 'file',
      type: typeof att.type === 'string' ? att.type.slice(0, 120) : 'application/octet-stream',
      data,
      size: typeof att.size === 'number' ? att.size : undefined,
    });
  }
  return clean;
}

function decodeBase64DataUrl(dataUrl: string): Buffer | null {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return null;
  try {
    return Buffer.from(dataUrl.slice(comma + 1), 'base64');
  } catch {
    return null;
  }
}

function isTextAttachment(att: Attachment): boolean {
  const mime = (att.type || '').toLowerCase();
  const ext = (att.name || '').split('.').pop()?.toLowerCase() || '';
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/javascript') {
    return true;
  }
  return [
    'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonc', 'xml', 'yaml', 'yml', 'toml', 'ini',
    'env', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'php', 'py', 'rb', 'go', 'rs', 'java', 'kt',
    'c', 'cpp', 'h', 'hpp', 'cs', 'swift', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'sql',
    'sh', 'bash', 'zsh', 'ps1', 'dockerfile', 'gitignore', 'svg',
  ].includes(ext);
}

function extractArchiveOrDocText(att: Attachment): string {
  const ext = (att.name || '').split('.').pop()?.toLowerCase() || '';
  const buf = decodeBase64DataUrl(att.data);
  if (!buf) return '';

  if (ext === 'zip') {
    try {
      const zip = new AdmZip(buf);
      const entries = zip.getEntries().filter((e) => !e.isDirectory).slice(0, ARCHIVE_MAX_FILES);
      const sections: string[] = [];
      let totalBytes = 0;
      sections.push(`ZIP manifest (${entries.length} files):\n` + entries.map((e) => `- ${e.entryName} (${e.header.size} bytes)`).join('\n'));
      for (const entry of entries) {
        if (totalBytes >= ARCHIVE_MAX_UNPACKED_BYTES || entry.header.size > ARCHIVE_MAX_FILE_BYTES) continue;
        const fakeAtt: Attachment = { name: entry.entryName, type: '', data: '' };
        if (isTextAttachment(fakeAtt)) {
          const text = entry.getData().toString('utf8');
          totalBytes += entry.header.size;
          sections.push(`### ${entry.entryName}\n\`\`\`\n${text.slice(0, 20000)}\n\`\`\``);
        }
      }
      return sections.join('\n\n').slice(0, ARCHIVE_MAX_TEXT_CHARS);
    } catch (e) {
      return `Unable to read ZIP archive (${att.name}): ${e instanceof Error ? e.message : 'invalid archive'}`;
    }
  }

  if (ext === 'docx') {
    try {
      const zip = new AdmZip(buf);
      const docXml = zip.readAsText('word/document.xml');
      if (docXml) {
        const plain = docXml
          .replace(/<w:p[^>]*>/g, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        return `DOCX content (${att.name}):\n\n${plain.slice(0, ARCHIVE_MAX_TEXT_CHARS)}`;
      }
    } catch {
      // fall through
    }
  }

  if (ext === 'pdf') {
    const raw = buf.toString('latin1');
    const textMatches = [...raw.matchAll(/\(([^()\\]{2,200})\)\s*Tj/g)].map((m) => m[1]);
    if (textMatches.length > 0) {
      return `PDF extracted text (${att.name}):\n\n${textMatches.join(' ').slice(0, ARCHIVE_MAX_TEXT_CHARS)}`;
    }
    return `PDF attachment (${att.name}, ${buf.length} bytes).`;
  }

  return '';
}

export function expandZipImages(attachments: Attachment[]): Attachment[] {
  const expanded = [...attachments];
  for (const att of attachments) {
    if (!att.name.toLowerCase().endsWith('.zip')) continue;
    if (expanded.length >= 4) break;
    const buf = decodeBase64DataUrl(att.data);
    if (!buf) continue;
    try {
      const zip = new AdmZip(buf);
      for (const entry of zip.getEntries()) {
        if (expanded.length >= 4) break;
        if (entry.isDirectory || entry.header.size > 4 * 1024 * 1024) continue;
        const lower = entry.entryName.toLowerCase();
        let mime = '';
        if (lower.endsWith('.png')) mime = 'image/png';
        else if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) mime = 'image/jpeg';
        else if (lower.endsWith('.webp')) mime = 'image/webp';
        else if (lower.endsWith('.gif')) mime = 'image/gif';
        if (!mime) continue;
        const b64 = entry.getData().toString('base64');
        expanded.push({
          name: entry.entryName,
          type: mime,
          data: `data:${mime};base64,${b64}`,
        });
      }
    } catch {
      // ignore invalid zip
    }
  }
  return expanded;
}

function buildMessageContent(text: string, attachments: Attachment[], allowImages: boolean): unknown {
  const parts: Array<Record<string, unknown>> = [];
  let textAcc = text || '';

  for (const att of attachments) {
    if ((att.type || '').startsWith('image/') && att.data.startsWith('data:image/')) {
      if (allowImages) {
        parts.push({ type: 'image_url', image_url: { url: att.data } });
      } else {
        textAcc += `\n\n[Image attached: ${att.name}]`;
      }
      continue;
    }
    if (isTextAttachment(att)) {
      const buf = decodeBase64DataUrl(att.data);
      if (buf) {
        const decoded = buf.toString('utf8').slice(0, CODE_MAX_CONTEXT_CHARS);
        textAcc += `\n\n[Attached file: ${att.name}]\n\`\`\`\n${decoded}\n\`\`\``;
      }
      continue;
    }
    const extracted = extractArchiveOrDocText(att);
    if (extracted) {
      textAcc += `\n\n${extracted}`;
    } else {
      textAcc += `\n\n[Attached file: ${att.name} (${att.type})]`;
    }
  }

  if (parts.length > 0) {
    parts.unshift({ type: 'text', text: textAcc });
    return parts;
  }
  return textAcc;
}

export function buildApiMessagesFromHistory(
  history: unknown[],
  currentMessage: string,
  attachments: Attachment[],
  allowImages: boolean,
  langCode: string,
  githubContext: string,
  mode: string
): ChatMessage[] {
  const langName = LANGUAGES.find((l) => l.code === langCode)?.name || '';
  const modeInstruction = MODE_INSTRUCTIONS[mode] || MODE_INSTRUCTIONS.fast;

  let systemPrompt =
    "You are Ptero, the site's primary AI assistant: capable, practical, honest, and easy to work with. " +
    'Format code cleanly using fenced markdown blocks with language tags (and optional :filename.ext when generating files). ' +
    modeInstruction;

  if (langName && langCode !== 'en') {
    systemPrompt += `\nRespond in ${langName} unless the user asks for another language.`;
  }
  if (githubContext) {
    systemPrompt += `\n\n${githubContext}`;
  }

  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }];

  const historyLimit = getChatHistoryLimit(mode);
  const rawHistory = Array.isArray(history) ? history : [];
  let charBudget = 0;
  const keptHistory: ChatMessage[] = [];

  for (let i = rawHistory.length - 1; i >= 0; i--) {
    const turn = rawHistory[i] as Record<string, unknown> | undefined;
    if (!turn || typeof turn !== 'object') continue;
    const role = turn.role === 'assistant' ? 'assistant' : 'user';
    const contentText = typeof turn.text === 'string' ? turn.text : typeof turn.content === 'string' ? turn.content : '';
    const turnAtts = sanitizeAttachments(turn.attachments);
    const content = buildMessageContent(contentText, turnAtts, allowImages);
    const size = typeof content === 'string' ? content.length : JSON.stringify(content).length;
    if (charBudget + size > historyLimit && keptHistory.length > 0) break;
    charBudget += size;
    keptHistory.unshift({ role, content });
  }

  messages.push(...keptHistory);
  messages.push({
    role: 'user',
    content: buildMessageContent(currentMessage, attachments, allowImages),
  });
  return messages;
}

// ---------------------------------------------------------------------------
// GitHub Public API + Tool Execution
// ---------------------------------------------------------------------------

export function parseGithubRepo(raw: string): { owner: string; repo: string } | null {
  let clean = (raw || '').trim();
  if (!clean) return null;
  clean = clean.replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  const parts = clean.split('/');
  if (parts.length < 2) return null;
  const owner = parts[0].trim();
  const repo = parts[1].trim();
  if (!/^[a-zA-Z0-9_.-]+$/.test(owner) || !/^[a-zA-Z0-9_.-]+$/.test(repo)) return null;
  return { owner, repo };
}

export async function githubApiGet(path: string): Promise<Record<string, unknown> | { error: string; status: number }> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Ptero-AI-Chat',
  };
  if (process.env.MLP_GITHUB_PAT) {
    headers.Authorization = `Bearer ${process.env.MLP_GITHUB_PAT}`;
  }
  try {
    const resp = await fetch(`https://api.github.com${path}`, { headers });
    const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    if (!resp.ok) {
      return {
        error: typeof data.message === 'string' ? data.message : `GitHub API error (${resp.status})`,
        status: resp.status,
      };
    }
    return data;
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'GitHub request failed', status: 502 };
  }
}

export async function fetchGithubRepoSummary(owner: string, repo: string): Promise<Record<string, unknown> | { error: string; status: number }> {
  const info = await githubApiGet(`/repos/${owner}/${repo}`);
  if ('error' in info) return info;
  const defaultBranch = typeof info.default_branch === 'string' ? info.default_branch : 'main';
  const treeResp = await githubApiGet(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`);
  const files: string[] = [];
  if (!('error' in treeResp) && Array.isArray(treeResp.tree)) {
    for (const item of treeResp.tree as Array<{ type?: string; path?: string }>) {
      if (item.type === 'blob' && item.path) {
        files.push(item.path);
        if (files.length >= 200) break;
      }
    }
  }
  return {
    full_name: info.full_name || `${owner}/${repo}`,
    description: info.description || '',
    language: info.language || '',
    default_branch: defaultBranch,
    stars: info.stargazers_count || 0,
    files,
  };
}

export function getGithubToolsSchema() {
  return [
    {
      type: 'function',
      function: {
        name: 'github_read_file',
        description: 'Read the contents of a file from a public GitHub repository.',
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/repo' },
            path: { type: 'string', description: 'Path to file inside the repository' },
            ref: { type: 'string', description: 'Branch or commit ref (optional)' },
          },
          required: ['repo', 'path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'github_search_code',
        description: 'Search code inside a public GitHub repository.',
        parameters: {
          type: 'object',
          properties: {
            repo: { type: 'string', description: 'owner/repo' },
            query: { type: 'string', description: 'Search query' },
          },
          required: ['repo', 'query'],
        },
      },
    },
  ];
}

export async function executeGithubTool(name: string, args: Record<string, unknown>): Promise<string> {
  const parsed = parseGithubRepo(String(args.repo || ''));
  if (!parsed) {
    return JSON.stringify({ error: 'Invalid repository format. Expected owner/repo.' });
  }
  if (name === 'github_read_file') {
    const filePath = String(args.path || '').replace(/^\/+/, '');
    const ref = args.ref ? `?ref=${encodeURIComponent(String(args.ref))}` : '';
    const data = await githubApiGet(`/repos/${parsed.owner}/${parsed.repo}/contents/${filePath}${ref}`);
    if ('error' in data) return JSON.stringify(data);
    if (typeof data.content === 'string') {
      const decoded = Buffer.from(data.content, 'base64').toString('utf8');
      return decoded.slice(0, CODE_CHUNK_MAX_CHARS);
    }
    return JSON.stringify(data);
  }
  if (name === 'github_search_code') {
    const q = `${String(args.query || '').trim()} repo:${parsed.owner}/${parsed.repo}`;
    const data = await githubApiGet(`/search/code?q=${encodeURIComponent(q)}&per_page=10`);
    return JSON.stringify(data);
  }
  return JSON.stringify({ error: `Unknown tool: ${name}` });
}

export async function fetchLiveWebContext(message: string): Promise<string> {
  const key = process.env.MLP_WEBCLAW_AI_KEY?.trim() || process.env.MLP_TINYFISH_KEY?.trim();
  if (!key) return '';
  const urls = message.match(/https?:\/\/[^\s<>"')]+/gi) || [];
  if (urls.length === 0) return '';
  try {
    const resp = await fetch(WEBCLAW_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ url: urls[0] }),
    });
    if (!resp.ok) return '';
    const data = (await resp.json()) as { content?: string; markdown?: string; text?: string };
    const text = data.markdown || data.content || data.text || '';
    if (!text) return '';
    return `Web page context (${urls[0]}):\n${text.slice(0, 12000)}`;
  } catch {
    return '';
  }
}

export function createUuid(): string {
  return crypto.randomUUID();
}
