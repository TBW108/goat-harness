import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_SETTINGS = {
  defaultModel: '',
  claudePath: '',
  permissionMode: 'acceptEdits',
  reasoningEffort: 'medium',
  strictVerifyHook: true,
  apiBaseUrl: 'https://api.openai.com/v1',
  authBaseUrl: 'https://auth.openai.com',
};

const MAX_RUN_FILES = 50;
const MAX_USAGE_DAYS = 90;
const LOCK_STALE_MS = 30_000;

export const CHATGPT_USAGE_SETTINGS_URL = 'https://chatgpt.com/#settings';
export const CHATGPT_SERVER_QUOTA_NOTE =
  'OpenAI Sign-in-with-ChatGPT OAuth tokens (chatgpt.tokens.use.direct) cannot query server-side remaining percentage quota via API. Local token totals are exact for requests routed through GOAT Harness; visit ChatGPT Settings for server-side weekly caps.';
export const VALID_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function normalizeReasoningEffort(value, fallback = 'medium') {
  const normalized = String(value || '').trim().toLowerCase();
  if (VALID_REASONING_EFFORTS.includes(normalized)) return normalized;
  return VALID_REASONING_EFFORTS.includes(fallback) ? fallback : 'medium';
}

/**
 * Returns the shared persistent directory used by Sidecar, MCP server, and hooks.
 * @returns {string}
 */
export function getStateDir() {
  return process.env.GOAT_HARNESS_HOME || join(homedir(), '.goat-harness');
}

function ensurePrivateDir(dirPath) {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(dirPath, 0o700);
  } catch {
    // Best-effort on platforms where chmod is restricted.
  }
}

export function readJsonSafe(filePath, fallback) {
  try {
    if (!existsSync(filePath)) return structuredClone(fallback);
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : structuredClone(fallback);
  } catch {
    return structuredClone(fallback);
  }
}

export function writeJsonAtomic(filePath, data, mode = 0o600) {
  const dir = join(filePath, '..');
  ensurePrivateDir(dir);
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf-8', mode });
  try {
    chmodSync(tmpPath, mode);
  } catch {
    // Ignore on filesystems without POSIX permissions.
  }
  renameSync(tmpPath, filePath);
}

/**
 * Executes an async function under a cross-process lockfile.
 * Prevents concurrent OAuth refresh_token rotation races between Sidecar and MCP.
 * @template T
 * @param {string} lockName
 * @param {() => Promise<T>} fn
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<T>}
 */
export async function withFileLock(lockName, fn, timeoutMs = 15_000) {
  const dir = getStateDir();
  ensurePrivateDir(dir);
  const lockPath = join(dir, `${lockName}.lock`);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // Lock disappeared while inspecting; retry immediately.
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for lock ${lockName}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Lock already removed.
    }
  }
}

export function getAuthPath() {
  return join(getStateDir(), 'auth.json');
}

export function getSettingsPath() {
  return join(getStateDir(), 'settings.json');
}

export function getRunsDir() {
  return join(getStateDir(), 'runs');
}

export function getHooksDir() {
  return join(getStateDir(), 'hooks');
}

export function getUsagePath() {
  return join(getStateDir(), 'usage.json');
}

export function getAuth() {
  return readJsonSafe(getAuthPath(), {
    hostId: '',
    openai: null,
    apiKeyFallback: '',
  });
}

export function saveAuth(auth) {
  writeJsonAtomic(getAuthPath(), auth, 0o600);
  return auth;
}

export function ensureHostId() {
  const auth = getAuth();
  if (!auth.hostId) {
    auth.hostId = `urn:uuid:${randomUUID()}`;
    saveAuth(auth);
  }
  return auth.hostId;
}

export function clearOpenAIAuth() {
  const auth = getAuth();
  auth.openai = null;
  saveAuth(auth);
  return auth;
}

export function getSettings() {
  const raw = readJsonSafe(getSettingsPath(), DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...raw };
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  writeJsonAtomic(getSettingsPath(), next, 0o600);
  return next;
}

function sanitizeRunId(runId) {
  return String(runId || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

export function saveRun(run) {
  const id = sanitizeRunId(run?.id);
  if (!id) throw new Error('Invalid run id');
  const dir = getRunsDir();
  ensurePrivateDir(dir);
  const filePath = join(dir, `${id}.json`);
  writeJsonAtomic(filePath, { ...run, id, updatedAt: new Date().toISOString() }, 0o600);
  pruneOldRuns(dir);
  return filePath;
}

export function getRun(runId) {
  const id = sanitizeRunId(runId);
  if (!id) return null;
  const filePath = join(getRunsDir(), `${id}.json`);
  if (!existsSync(filePath)) return null;
  return readJsonSafe(filePath, null);
}

export function listRuns(limit = 20) {
  const dir = getRunsDir();
  if (!existsSync(dir)) return [];
  const entries = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const data = readJsonSafe(join(dir, name), null);
    if (data && data.id) entries.push(data);
  }
  entries.sort((a, b) => Date.parse(b.startedAt || b.updatedAt || 0) - Date.parse(a.startedAt || a.updatedAt || 0));
  return entries.slice(0, Math.max(1, limit));
}

function pruneOldRuns(dir) {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const p = join(dir, f);
        return { p, mtime: statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const stale of files.slice(MAX_RUN_FILES)) {
      unlinkSync(stale.p);
    }
  } catch {
    // Non-fatal cleanup.
  }
}

export function getHookState(conversationId) {
  const id = sanitizeRunId(conversationId) || 'default';
  return readJsonSafe(join(getHooksDir(), `${id}.json`), {
    conversationId: id,
    editedFiles: [],
    dirtySinceVerify: false,
    lastVerifyCommand: '',
    lastVerifyAt: '',
    stopPromptedForBatch: false,
  });
}

export function saveHookState(conversationId, state) {
  const id = sanitizeRunId(conversationId) || 'default';
  writeJsonAtomic(join(getHooksDir(), `${id}.json`), { ...state, conversationId: id }, 0o600);
}

function emptyUsageBucket() {
  return {
    requests: 0,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

function defaultUsageStore() {
  return {
    version: 1,
    updatedAt: '',
    totals: emptyUsageBucket(),
    byModel: {},
    daily: {},
    lastRequest: null,
    lastQuotaError: null,
  };
}

function addToUsageBucket(target, delta) {
  target.requests += delta.requests;
  target.inputTokens += delta.inputTokens;
  target.cachedTokens += delta.cachedTokens;
  target.outputTokens += delta.outputTokens;
  target.reasoningTokens += delta.reasoningTokens;
  target.totalTokens += delta.totalTokens;
}

function formatLocalDateKey(ts) {
  const d = new Date(ts);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function pruneDailyUsage(daily) {
  const keys = Object.keys(daily).sort();
  if (keys.length <= MAX_USAGE_DAYS) return;
  for (const stale of keys.slice(0, keys.length - MAX_USAGE_DAYS)) {
    delete daily[stale];
  }
}

function sumDailyRange(daily, startDateKey, endDateKey) {
  const summary = { ...emptyUsageBucket(), byModel: {} };
  for (const [dateKey, entry] of Object.entries(daily || {})) {
    if (dateKey < startDateKey || dateKey > endDateKey || !entry) continue;
    addToUsageBucket(summary, {
      requests: Number(entry.requests) || 0,
      inputTokens: Number(entry.inputTokens) || 0,
      cachedTokens: Number(entry.cachedTokens) || 0,
      outputTokens: Number(entry.outputTokens) || 0,
      reasoningTokens: Number(entry.reasoningTokens) || 0,
      totalTokens: Number(entry.totalTokens) || 0,
    });
    for (const [model, modelEntry] of Object.entries(entry.byModel || {})) {
      if (!summary.byModel[model]) summary.byModel[model] = emptyUsageBucket();
      addToUsageBucket(summary.byModel[model], {
        requests: Number(modelEntry.requests) || 0,
        inputTokens: Number(modelEntry.inputTokens) || 0,
        cachedTokens: Number(modelEntry.cachedTokens) || 0,
        outputTokens: Number(modelEntry.outputTokens) || 0,
        reasoningTokens: Number(modelEntry.reasoningTokens) || 0,
        totalTokens: Number(modelEntry.totalTokens) || 0,
      });
    }
  }
  return summary;
}

/**
 * Records token usage from one completed OpenAI Responses API turn.
 * @param {{
 *   model?: string,
 *   requestedModel?: string,
 *   source?: string,
 *   requests?: number,
 *   inputTokens?: number,
 *   cachedTokens?: number,
 *   outputTokens?: number,
 *   reasoningTokens?: number,
 *   totalTokens?: number,
 *   latencyMs?: number,
 *   timestamp?: string|number,
 * }} [event]
 */
export async function recordUsageEvent(event = {}) {
  return withFileLock('usage', async () => {
    const filePath = getUsagePath();
    const raw = readJsonSafe(filePath, null);
    const store = raw && typeof raw === 'object' ? { ...defaultUsageStore(), ...raw } : defaultUsageStore();
    if (!store.totals) store.totals = emptyUsageBucket();
    if (!store.byModel) store.byModel = {};
    if (!store.daily) store.daily = {};

    const ts =
      typeof event.timestamp === 'number'
        ? event.timestamp
        : event.timestamp
          ? Date.parse(event.timestamp) || Date.now()
          : Date.now();
    const iso = new Date(ts).toISOString();
    const dateKey = formatLocalDateKey(ts);
    const model = String(event.model || 'unknown').trim() || 'unknown';

    const inputTokens = Math.max(0, Number(event.inputTokens) || 0);
    const cachedTokens = Math.max(0, Number(event.cachedTokens) || 0);
    const outputTokens = Math.max(0, Number(event.outputTokens) || 0);
    const reasoningTokens = Math.max(0, Number(event.reasoningTokens) || 0);
    const totalTokens = Math.max(0, Number(event.totalTokens) || inputTokens + outputTokens);
    const delta = {
      requests: Math.max(1, Number(event.requests) || 1),
      inputTokens,
      cachedTokens,
      outputTokens,
      reasoningTokens,
      totalTokens,
    };

    addToUsageBucket(store.totals, delta);

    if (!store.byModel[model]) {
      store.byModel[model] = { ...emptyUsageBucket(), lastUsedAt: iso };
    }
    addToUsageBucket(store.byModel[model], delta);
    store.byModel[model].lastUsedAt = iso;

    if (!store.daily[dateKey]) {
      store.daily[dateKey] = { ...emptyUsageBucket(), byModel: {} };
    }
    addToUsageBucket(store.daily[dateKey], delta);
    if (!store.daily[dateKey].byModel) store.daily[dateKey].byModel = {};
    if (!store.daily[dateKey].byModel[model]) {
      store.daily[dateKey].byModel[model] = emptyUsageBucket();
    }
    addToUsageBucket(store.daily[dateKey].byModel[model], delta);
    pruneDailyUsage(store.daily);

    store.lastRequest = {
      timestamp: iso,
      model,
      requestedModel: String(event.requestedModel || ''),
      source: String(event.source || 'anthropic-proxy'),
      inputTokens,
      cachedTokens,
      outputTokens,
      reasoningTokens,
      totalTokens,
      latencyMs: Math.max(0, Number(event.latencyMs) || 0),
    };
    store.updatedAt = iso;

    writeJsonAtomic(filePath, store, 0o600);
    return store;
  });
}

/**
 * Records an upstream rate-limit or quota error returned by OpenAI so usage UI can surface it.
 */
export async function recordQuotaEvent(event = {}) {
  return withFileLock('usage', async () => {
    const filePath = getUsagePath();
    const raw = readJsonSafe(filePath, null);
    const store = raw && typeof raw === 'object' ? { ...defaultUsageStore(), ...raw } : defaultUsageStore();
    const ts =
      typeof event.timestamp === 'number'
        ? event.timestamp
        : event.timestamp
          ? Date.parse(event.timestamp) || Date.now()
          : Date.now();
    const iso = new Date(ts).toISOString();

    store.lastQuotaError = {
      timestamp: iso,
      status: Number(event.status) || 429,
      model: String(event.model || ''),
      message: String(event.message || '').slice(0, 500),
      retryAfter: event.retryAfter ? String(event.retryAfter) : '',
    };
    store.updatedAt = iso;
    writeJsonAtomic(filePath, store, 0o600);
    return store.lastQuotaError;
  });
}

/**
 * Returns aggregated local token usage statistics across today, 7d, 30d, all-time, and per-model.
 */
export function getUsageSummary({ now = Date.now() } = {}) {
  const filePath = getUsagePath();
  const raw = readJsonSafe(filePath, null);
  const store = raw && typeof raw === 'object' ? { ...defaultUsageStore(), ...raw } : defaultUsageStore();
  const nowMs = typeof now === 'number' ? now : Date.parse(now) || Date.now();
  const noon = new Date(nowMs);
  noon.setHours(12, 0, 0, 0);

  const todayDate = formatLocalDateKey(noon.getTime());
  const start7 = formatLocalDateKey(noon.getTime() - 6 * 86_400_000);
  const start30 = formatLocalDateKey(noon.getTime() - 29 * 86_400_000);

  const today = sumDailyRange(store.daily, todayDate, todayDate);
  const last7Days = sumDailyRange(store.daily, start7, todayDate);
  const last30Days = sumDailyRange(store.daily, start30, todayDate);

  const allTimeTotals = {
    ...emptyUsageBucket(),
    ...(store.totals || {}),
  };

  return {
    usagePath: filePath,
    updatedAt: store.updatedAt || '',
    todayDate,
    daysTracked: Object.keys(store.daily || {}).length,
    today,
    last7Days,
    last30Days,
    allTime: allTimeTotals,
    byModel: store.byModel || {},
    lastRequest: store.lastRequest || null,
    lastQuotaError: store.lastQuotaError || null,
    chatgptUsageSettingsUrl: CHATGPT_USAGE_SETTINGS_URL,
    serverQuotaNote: CHATGPT_SERVER_QUOTA_NOTE,
  };
}

/**
 * Clears local recorded token usage history.
 */
export async function resetUsageStats() {
  return withFileLock('usage', async () => {
    const filePath = getUsagePath();
    writeJsonAtomic(filePath, defaultUsageStore(), 0o600);
    return { reset: true, usagePath: filePath };
  });
}

export function formatTokenCount(count) {
  const n = Math.max(0, Number(count) || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatUsageReport(summary) {
  const s = summary || getUsageSummary();
  const fmtBucket = (label, b) =>
    `${label}: ${b.requests || 0} reqs | total ${formatTokenCount(b.totalTokens)} (in ${formatTokenCount(
      b.inputTokens
    )}, cached ${formatTokenCount(b.cachedTokens)}, out ${formatTokenCount(
      b.outputTokens
    )}, reasoning ${formatTokenCount(b.reasoningTokens)})`;

  const lines = [
    `Local Usage Ledger (${s.usagePath})`,
    `  ${fmtBucket(`Today (${s.todayDate})`, s.today)}`,
    `  ${fmtBucket('Last 7 days       ', s.last7Days)}`,
    `  ${fmtBucket('Last 30 days      ', s.last30Days)}`,
    `  ${fmtBucket('All time          ', s.allTime)}`,
  ];

  const modelEntries = Object.entries(s.byModel || {}).sort(
    (a, b) => (b[1]?.totalTokens || 0) - (a[1]?.totalTokens || 0)
  );
  if (modelEntries.length) {
    lines.push('By Model (all time):');
    for (const [slug, stats] of modelEntries) {
      lines.push(
        `  - ${slug}: ${stats.requests || 0} reqs | total ${formatTokenCount(
          stats.totalTokens
        )} (in ${formatTokenCount(stats.inputTokens)}, out ${formatTokenCount(
          stats.outputTokens
        )}, reasoning ${formatTokenCount(stats.reasoningTokens)})`
      );
    }
  } else {
    lines.push('By Model: no requests recorded yet.');
  }

  if (s.lastRequest) {
    lines.push(
      `Last Request : ${s.lastRequest.timestamp} | ${s.lastRequest.model} | total ${formatTokenCount(
        s.lastRequest.totalTokens
      )} (${s.lastRequest.latencyMs || 0}ms)`
    );
  }
  if (s.lastQuotaError) {
    lines.push(
      `Last Quota Err: HTTP ${s.lastQuotaError.status} (${s.lastQuotaError.timestamp}) ${s.lastQuotaError.message}`
    );
  }
  lines.push(`ChatGPT Plan Quota Settings: ${s.chatgptUsageSettingsUrl}`);
  lines.push(`Note: ${s.serverQuotaNote}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Checks whether the current ES module is the Node.js entrypoint, resolving symlinks
 * (required when Antigravity runs plugin scripts via ~/.gemini/config/plugins/<name>).
 * @param {string} metaUrl
 * @returns {boolean}
 */
export function isMainModule(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return metaUrl === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return metaUrl === pathToFileURL(entry).href;
  }
}
