import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cancelHarnessRun,
  checkClaudeHealth,
  runClaudeHarness,
} from '../../lib/claude-harness.mjs';
import { syncInstalledClaudeModel } from '../../lib/claude-installer.mjs';
import {
  cancelPendingOAuth,
  fetchOpenAIModels,
  getAuthSummary,
  selectModelTiers,
  signOutChatGPT,
  startSignInWithChatGPT,
} from '../../lib/openai-oauth.mjs';
import {
  getAuth,
  getRun,
  getSettings,
  getUsageSummary,
  isMainModule,
  listRuns,
  resetUsageStats,
  saveAuth,
  saveSettings,
  VALID_REASONING_EFFORTS,
} from '../../lib/store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATIC_ASSETS = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

const inFlightErrors = new Map();

export function createSidecarHandlers(deps = {}) {
  const fetchModelsFn = deps.fetchOpenAIModels || fetchOpenAIModels;
  const startOAuthFn = deps.startSignInWithChatGPT || startSignInWithChatGPT;
  const runHarnessFn = deps.runClaudeHarness || runClaudeHarness;
  const getUsageSummaryFn = deps.getUsageSummary || getUsageSummary;
  const resetUsageStatsFn = deps.resetUsageStats || resetUsageStats;

  return {
    getState() {
      const settings = getSettings();
      const auth = getAuthSummary();
      const claude = checkClaudeHealth(settings.claudePath);
      const usage = getUsageSummaryFn();
      const runs = listRuns(15).map((r) => ({
        id: r.id,
        source: r.source,
        status: r.status,
        model: r.model,
        permissionMode: r.permissionMode,
        cwd: r.cwd,
        prompt: r.prompt,
        claudeSessionId: r.claudeSessionId,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        durationMs: r.durationMs,
        toolsCount: Array.isArray(r.toolsUsed) ? r.toolsUsed.length : 0,
        error: r.error || '',
      }));
      return {
        auth,
        claude,
        usage,
        settings: {
          defaultModel: settings.defaultModel,
          claudePath: settings.claudePath,
          permissionMode: settings.permissionMode,
          reasoningEffort: settings.reasoningEffort,
          strictVerifyHook: Boolean(settings.strictVerifyHook),
          apiBaseUrl: settings.apiBaseUrl,
          authBaseUrl: settings.authBaseUrl,
        },
        runs,
      };
    },

    getUsage() {
      return { ok: true, usage: getUsageSummaryFn() };
    },

    async resetUsage() {
      await resetUsageStatsFn();
      return { ok: true, reset: true, usage: getUsageSummaryFn() };
    },

    async getModels(data) {
      const forceRefresh = data?.refresh === 'true' || data?.refresh === true;
      try {
        const res = await fetchModelsFn({ forceRefresh });
        const settings = getSettings();
        return {
          ok: true,
          ...res,
          tiers: selectModelTiers(res.models || [], settings.defaultModel || ''),
        };
      } catch (err) {
        return {
          ok: false,
          models: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    getRunDetail(data) {
      const id = String(data?.id || '');
      if (!id) return { ok: false, error: 'Missing run id' };
      const run = getRun(id);
      if (!run) return { ok: false, error: 'Run not found' };
      return {
        ok: true,
        run,
        launchError: inFlightErrors.get(id) || '',
      };
    },

    async startOAuth(data) {
      const openBrowser = data?.openBrowser !== false;
      const started = await startOAuthFn({ openBrowser });
      started.completionPromise.catch(() => {});
      return {
        ok: true,
        authUrl: started.authUrl,
        redirectUri: started.redirectUri,
      };
    },

    cancelOAuth() {
      cancelPendingOAuth();
      return { ok: true };
    },

    logoutOAuth() {
      signOutChatGPT();
      return { ok: true };
    },

    updateSettings(data) {
      const allowed = {};
      if (typeof data?.defaultModel === 'string') allowed.defaultModel = data.defaultModel.trim();
      if (typeof data?.claudePath === 'string') allowed.claudePath = data.claudePath.trim();
      if (
        typeof data?.permissionMode === 'string' &&
        ['plan', 'acceptEdits', 'dontAsk', 'bypassPermissions'].includes(data.permissionMode)
      ) {
        allowed.permissionMode = data.permissionMode;
      }
      if (typeof data?.reasoningEffort === 'string') {
        const effort = data.reasoningEffort.trim().toLowerCase();
        if (VALID_REASONING_EFFORTS.includes(effort)) {
          allowed.reasoningEffort = effort;
        }
      }
      if (typeof data?.strictVerifyHook === 'boolean') {
        allowed.strictVerifyHook = data.strictVerifyHook;
      }
      if (typeof data?.apiBaseUrl === 'string' && data.apiBaseUrl.trim()) {
        allowed.apiBaseUrl = data.apiBaseUrl.trim();
      }
      if (typeof data?.authBaseUrl === 'string' && data.authBaseUrl.trim()) {
        allowed.authBaseUrl = data.authBaseUrl.trim();
      }

      const updated = saveSettings(allowed);
      if (allowed.defaultModel || allowed.reasoningEffort) {
        try {
          syncInstalledClaudeModel({
            model: updated.defaultModel,
            effort: updated.reasoningEffort,
          });
        } catch {
          // Non-fatal if Claude Code settings cannot be synced.
        }
      }

      if (typeof data?.apiKeyFallback === 'string') {
        const auth = getAuth();
        auth.apiKeyFallback = data.apiKeyFallback.trim();
        saveAuth(auth);
      }

      return { ok: true, settings: updated, auth: getAuthSummary() };
    },

    startRun(data) {
      const prompt = String(data?.prompt || '').trim();
      if (!prompt) {
        return { ok: false, error: 'Prompt cannot be empty.' };
      }
      const cwd = String(data?.cwd || process.cwd()).trim() || process.cwd();
      const model = String(data?.model || '').trim();
      const permissionMode = String(data?.permissionMode || '').trim();
      const resumeSessionId = String(data?.resumeSessionId || '').trim();
      const runId = `run_${Date.now()}_${randomUUID().slice(0, 8)}`;

      const promise = runHarnessFn({
        runId,
        prompt,
        cwd,
        model,
        permissionMode,
        resumeSessionId,
        source: 'sidecar',
      });

      promise.catch((err) => {
        inFlightErrors.set(runId, err instanceof Error ? err.message : String(err));
      });

      return { ok: true, runId };
    },

    cancelRun(data) {
      const runId = String(data?.runId || '').trim();
      if (!runId) return { ok: false, error: 'Missing runId' };
      const cancelled = cancelHarnessRun(runId);
      return { ok: true, cancelled };
    },
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export async function startStandaloneServer(handlers = createSidecarHandlers(), port = 0) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const path = url.pathname;

    try {
      if (req.method === 'GET' && path === '/') {
        const html = readFileSync(join(__dirname, 'index.html'), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && path === '/preload.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end('/* standalone fallback */');
        return;
      }

      if (req.method === 'GET' && STATIC_ASSETS[path]) {
        const [file, type] = STATIC_ASSETS[path];
        res.writeHead(200, { 'Content-Type': type });
        res.end(readFileSync(join(__dirname, file), 'utf-8'));
        return;
      }

      const sendJson = (status, body) => {
        const text = JSON.stringify(body);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(text);
      };

      const queryData = Object.fromEntries(url.searchParams.entries());
      if (req.method === 'GET' && path === '/api/state') {
        return sendJson(200, handlers.getState(queryData));
      }
      if (req.method === 'GET' && path === '/api/models') {
        return sendJson(200, await handlers.getModels(queryData));
      }
      if (req.method === 'GET' && path === '/api/usage') {
        return sendJson(200, handlers.getUsage(queryData));
      }
      if (req.method === 'GET' && path === '/api/run') {
        return sendJson(200, handlers.getRunDetail(queryData));
      }

      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (path === '/api/oauth/start') return sendJson(200, await handlers.startOAuth(body));
        if (path === '/api/oauth/cancel') return sendJson(200, handlers.cancelOAuth(body));
        if (path === '/api/oauth/logout') return sendJson(200, handlers.logoutOAuth(body));
        if (path === '/api/settings') return sendJson(200, handlers.updateSettings(body));
        if (path === '/api/usage/reset') return sendJson(200, await handlers.resetUsage(body));
        if (path === '/api/run/start') return sendJson(200, handlers.startRun(body));
        if (path === '/api/run/cancel') return sendJson(200, handlers.cancelRun(body));
      }

      sendJson(404, { error: 'Not found' });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function main() {
  const handlers = createSidecarHandlers();

  let sidecarSdk = null;
  try {
    sidecarSdk = await import('sidecar_sdk');
  } catch {
    sidecarSdk = null;
  }

  if (sidecarSdk?.SidecarApp) {
    const { SidecarApp, Response } = sidecarSdk;
    const app = new SidecarApp();

    app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

    for (const [route, [file, type]] of Object.entries(STATIC_ASSETS)) {
      app.api(
        route,
        () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType: type }),
        'GET'
      );
    }

    app.api('/api/state', (data) => handlers.getState(data), 'GET');
    app.api('/api/models', (data) => handlers.getModels(data), 'GET');
    app.api('/api/usage', (data) => handlers.getUsage(data), 'GET');
    app.api('/api/run', (data) => handlers.getRunDetail(data), 'GET');

    app.api('/api/oauth/start', (data) => handlers.startOAuth(data));
    app.api('/api/oauth/cancel', (data) => handlers.cancelOAuth(data));
    app.api('/api/oauth/logout', (data) => handlers.logoutOAuth(data));
    app.api('/api/settings', (data) => handlers.updateSettings(data));
    app.api('/api/usage/reset', (data) => handlers.resetUsage(data));
    app.api('/api/run/start', (data) => handlers.startRun(data));
    app.api('/api/run/cancel', (data) => handlers.cancelRun(data));

    app.run();
    return;
  }

  const standalonePort = Number(process.env.SIDECAR_PORT || 47123);
  const srv = await startStandaloneServer(handlers, standalonePort);
  console.log(`[goat_harness_ui] standalone server listening at http://127.0.0.1:${srv.port}`);
}

if (isMainModule(import.meta.url)) {
  await main();
}
