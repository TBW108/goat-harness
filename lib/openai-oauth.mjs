import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { proxyFetch } from './proxy-fetch.mjs';
import {
  clearOpenAIAuth,
  ensureHostId,
  getAuth,
  getSettings,
  saveAuth,
  withFileLock,
} from './store.mjs';

const OAUTH_SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const TOKEN_REFRESH_MARGIN_MS = 120_000;
const DEFAULT_OAUTH_TIMEOUT_MS = 300_000;
const MODEL_CACHE_TTL_MS = 60_000;

let activeLoginSession = null;
let lastLoginOutcome = null;
let discoveryCache = { authBaseUrl: '', fetchedAt: 0, endpoints: null };
let modelCache = { fetchedAt: 0, tokenKey: '', models: [] };

export function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function generatePkcePair() {
  const codeVerifier = base64UrlEncode(randomBytes(32));
  const codeChallenge = base64UrlEncode(createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

/**
 * Decodes a JWT payload without verifying signature (used only for display metadata).
 * @param {string} token
 * @returns {Record<string, any> | null}
 */
export function decodeJwtPayload(token) {
  try {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

export function extractAccountProfile(idToken, accessToken) {
  const idClaims = decodeJwtPayload(idToken) || {};
  const accessClaims = decodeJwtPayload(accessToken) || {};
  const authClaims =
    idClaims['https://api.openai.com/auth'] ||
    accessClaims['https://api.openai.com/auth'] ||
    {};

  return {
    sub: idClaims.sub || accessClaims.sub || '',
    email: idClaims.email || authClaims.email || '',
    name: idClaims.name || idClaims.preferred_username || '',
    planType: authClaims.chatgpt_plan_type || authClaims.plan_type || '',
  };
}

export async function getOidcEndpoints(authBaseUrl = getSettings().authBaseUrl, fetchImpl = proxyFetch) {
  const cleanBase = String(authBaseUrl || 'https://auth.openai.com').replace(/\/+$/, '');
  const now = Date.now();
  if (
    discoveryCache.endpoints &&
    discoveryCache.authBaseUrl === cleanBase &&
    now - discoveryCache.fetchedAt < 3_600_000
  ) {
    return discoveryCache.endpoints;
  }

  const defaults = {
    authorizationEndpoint: `${cleanBase}/api/accounts/authorize`,
    tokenEndpoint: `${cleanBase}/api/accounts/oauth/token`,
  };

  try {
    const res = await fetchImpl(`${cleanBase}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const doc = await res.json();
      const endpoints = {
        authorizationEndpoint: doc.authorization_endpoint || defaults.authorizationEndpoint,
        tokenEndpoint: doc.token_endpoint || defaults.tokenEndpoint,
      };
      discoveryCache = { authBaseUrl: cleanBase, fetchedAt: now, endpoints };
      return endpoints;
    }
  } catch {
    // Fall back to canonical endpoints if discovery fails or times out.
  }

  return defaults;
}

export function buildAuthorizationUrl({
  authorizationEndpoint,
  clientId,
  hostId,
  redirectUri,
  codeChallenge,
  state,
  nonce,
  agentNameHint = 'GOAT Harness',
  apiBaseUrl = 'https://api.openai.com/v1',
}) {
  const url = new URL(authorizationEndpoint);
  const effectiveClientId = clientId || 'dynamic_agent_client';
  url.searchParams.set('client_id', effectiveClientId);
  if (effectiveClientId === 'dynamic_agent_client' && agentNameHint) {
    url.searchParams.set('agent_name_hint', agentNameHint);
  }
  url.searchParams.set('ext_agent_host_id', hostId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', OAUTH_SCOPE);
  url.searchParams.set('resource', apiBaseUrl.replace(/\/+$/, ''));
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  return url.toString();
}

function openExternalUrl(url) {
  const platform = process.platform;
  if (platform === 'darwin') {
    execFile('open', [url], () => {});
  } else if (platform === 'win32') {
    execFile('cmd', ['/c', 'start', '', url], () => {});
  } else {
    execFile('xdg-open', [url], () => {});
  }
}

function renderCallbackHtml({ ok, title, detail }) {
  const accent = ok ? '#10b981' : '#ef4444';
  const esc = (s) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f172a; color: #f8fafc; display: grid; place-items: center; min-height: 100vh; margin: 0; }
    .card { max-width: 440px; padding: 28px 32px; background: #1e293b; border-radius: 14px; border: 1px solid #334155; box-shadow: 0 20px 50px rgba(0,0,0,0.45); }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; background: ${accent}22; color: ${accent}; margin-bottom: 12px; }
    h1 { font-size: 20px; margin: 0 0 10px; }
    p { font-size: 14px; line-height: 1.5; color: #cbd5e1; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">${ok ? 'Connected' : 'Sign-In Failed'}</div>
    <h1>${esc(title)}</h1>
    <p>${esc(detail)}</p>
  </div>
</body>
</html>`;
}

function formatOAuthTokenError(prefix, status, json, text) {
  const parts = [];
  if (json?.error) parts.push(String(json.error));
  if (json?.error_description && json.error_description !== json.error) {
    parts.push(String(json.error_description));
  }
  if (json?.error_reason) parts.push(`reason=${json.error_reason}`);
  const summary = parts.length ? parts.join(': ') : text || `HTTP ${status}`;
  const err = new Error(`${prefix}: ${summary}`);
  err.status = status;
  err.code = json?.error || '';
  return err;
}

export async function exchangeAuthorizationCode({
  tokenEndpoint,
  code,
  redirectUri,
  clientId,
  codeVerifier,
  resource = 'https://api.openai.com/v1',
  fetchImpl = proxyFetch,
}) {
  const normalizedResource = String(resource || '').replace(/\/+$/, '');
  const params = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  };
  if (normalizedResource) {
    params.resource = normalizedResource;
  }
  const body = new URLSearchParams(params);

  const res = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    // Keep empty object and inspect raw text on failure.
  }

  if (!res.ok) {
    throw formatOAuthTokenError('Token exchange failed', res.status, json, text);
  }

  return json;
}

export async function refreshAccessToken({
  tokenEndpoint,
  clientId,
  refreshToken,
  resource = 'https://api.openai.com/v1',
  fetchImpl = proxyFetch,
}) {
  const normalizedResource = String(resource || '').replace(/\/+$/, '');
  const params = {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  };
  if (normalizedResource) {
    params.resource = normalizedResource;
  }
  const body = new URLSearchParams(params);

  const res = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    // Ignore parse error on non-JSON response.
  }

  if (!res.ok) {
    const errCode = json.error || '';
    const errDesc = json.error_description || text || `HTTP ${res.status}`;
    const err = new Error(`Token refresh failed (${errCode || res.status}): ${errDesc}`);
    err.status = res.status;
    err.code = errCode;
    throw err;
  }

  return json;
}

export function cancelPendingOAuth() {
  if (!activeLoginSession) return;
  try {
    clearTimeout(activeLoginSession.timer);
    activeLoginSession.server?.close();
  } catch {
    // Ignore close errors.
  }
  activeLoginSession = null;
}

export function getPendingOAuthStatus() {
  if (!activeLoginSession) return { pending: false };
  return {
    pending: true,
    authUrl: activeLoginSession.authUrl,
    redirectUri: activeLoginSession.redirectUri || '',
    startedAt: activeLoginSession.startedAt,
    status: activeLoginSession.status,
    error: activeLoginSession.error || '',
  };
}

/**
 * Waits up to `timeoutMs` for an in-flight Sign in with ChatGPT session to finish.
 * Leaves the underlying loopback server alive if `timeoutMs` elapses before completion.
 * @param {number} [timeoutMs=120000]
 */
export async function waitForPendingOAuth(timeoutMs = 120_000) {
  const session = activeLoginSession;
  if (session?.completionPromise) {
    const clampedMs = Math.max(100, Number(timeoutMs) || 120_000);
    let timer = null;
    try {
      const outcome = await Promise.race([
        session.completionPromise.then((result) => ({ kind: 'done', result })),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'timeout' }), clampedMs);
        }),
      ]);
      if (outcome.kind === 'done') {
        return outcome.result;
      }
      return {
        ok: false,
        pending: true,
        authUrl: session.authUrl,
        redirectUri: session.redirectUri || '',
        error: 'Timed out waiting for ChatGPT browser callback; sign-in link is still active.',
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  if (lastLoginOutcome && Date.now() - lastLoginOutcome.finishedAt < 60_000) {
    return lastLoginOutcome.result;
  }

  const auth = getAuth();
  if (auth.openai?.accessToken) {
    return {
      ok: true,
      alreadyConnected: true,
      account: {
        email: auth.openai.email || '',
        name: auth.openai.name || '',
        planType: auth.openai.planType || '',
      },
      clientId: auth.openai.clientId || '',
    };
  }

  return {
    ok: false,
    pending: false,
    error: 'No pending ChatGPT sign-in session. Start login first.',
  };
}

/**
 * Starts a loopback PKCE "Sign in with ChatGPT" login flow.
 * Resolves immediately with { authUrl, waitForCompletion } so UI callers can
 * surface the clickable link while awaiting completion in the background.
 */
export async function startSignInWithChatGPT({
  openBrowser = true,
  timeoutMs = DEFAULT_OAUTH_TIMEOUT_MS,
  preferredPort = 0,
  fetchImpl = proxyFetch,
} = {}) {
  cancelPendingOAuth();
  lastLoginOutcome = null;

  const settings = getSettings();
  const auth = getAuth();
  const hostId = ensureHostId();
  const existingClientId = auth.openai?.clientId || '';
  const { codeVerifier, codeChallenge } = generatePkcePair();
  const state = base64UrlEncode(randomBytes(24));
  const nonce = randomUUID();
  const endpoints = await getOidcEndpoints(settings.authBaseUrl, fetchImpl);

  let resolveDone;
  const completionPromise = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const server = http.createServer();
  const listenPort = (port) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve(server.address().port);
      });
    });

  let port;
  try {
    port = await listenPort(preferredPort);
  } catch {
    port = await listenPort(0);
  }

  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  const authUrl = buildAuthorizationUrl({
    authorizationEndpoint: endpoints.authorizationEndpoint,
    clientId: existingClientId || 'dynamic_agent_client',
    hostId,
    redirectUri,
    codeChallenge,
    state,
    nonce,
    apiBaseUrl: settings.apiBaseUrl,
  });

  const session = {
    startedAt: new Date().toISOString(),
    authUrl,
    redirectUri,
    status: 'waiting_for_browser',
    error: '',
    server,
    timer: null,
    completionPromise,
  };
  activeLoginSession = session;

  let callbackInFlight = null;
  let callbackSettled = null;

  const finish = (result) => {
    clearTimeout(session.timer);
    try {
      server.close();
    } catch {
      // Ignore already closed.
    }
    lastLoginOutcome = { finishedAt: Date.now(), result };
    if (activeLoginSession === session) {
      activeLoginSession = null;
    }
    resolveDone(result);
  };

  session.timer = setTimeout(() => {
    session.status = 'timeout';
    session.error = 'Sign-in timed out before callback was received.';
    finish({ ok: false, error: session.error });
  }, timeoutMs);

  const runCallbackOnce = async (reqUrl) => {
    const returnedError = reqUrl.searchParams.get('error');
    const returnedDesc = reqUrl.searchParams.get('error_description');
    if (returnedError) {
      const msg = returnedDesc || returnedError;
      return {
        statusCode: 400,
        html: renderCallbackHtml({ ok: false, title: 'ChatGPT Sign-In Cancelled', detail: msg }),
        sessionStatus: 'error',
        sessionError: msg,
        result: { ok: false, error: msg },
      };
    }

    const returnedState = reqUrl.searchParams.get('state');
    const code = reqUrl.searchParams.get('code');
    const callbackClientId = reqUrl.searchParams.get('client_id') || '';
    const issuedClientId = callbackClientId || existingClientId;

    if (!returnedState || returnedState !== state) {
      const msg = 'OAuth state mismatch; rejected for CSRF safety.';
      return {
        statusCode: 400,
        html: renderCallbackHtml({ ok: false, title: 'Verification Failed', detail: msg }),
        sessionStatus: 'error',
        sessionError: msg,
        result: { ok: false, error: msg },
      };
    }

    if (!code) {
      const msg = 'Missing authorization code in callback.';
      return {
        statusCode: 400,
        html: renderCallbackHtml({ ok: false, title: 'Missing Code', detail: msg }),
        sessionStatus: 'error',
        sessionError: msg,
        result: { ok: false, error: msg },
      };
    }

    const tokenClientId = issuedClientId || 'dynamic_agent_client';
    const resourceUri = String(settings.apiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    try {
      const tokenPayload = await exchangeAuthorizationCode({
        tokenEndpoint: endpoints.tokenEndpoint,
        code,
        redirectUri,
        clientId: tokenClientId,
        codeVerifier,
        resource: resourceUri,
        fetchImpl,
      });

      const finalClientId = tokenPayload.client_id || issuedClientId || existingClientId;
      const expiresInSec = Number(tokenPayload.expires_in) || 3600;
      const profile = extractAccountProfile(tokenPayload.id_token, tokenPayload.access_token);

      const latestAuth = getAuth();
      latestAuth.hostId = hostId;
      latestAuth.openai = {
        clientId: finalClientId,
        accessToken: tokenPayload.access_token || '',
        refreshToken: tokenPayload.refresh_token || '',
        idToken: tokenPayload.id_token || '',
        expiresAt: Date.now() + expiresInSec * 1000,
        scope: tokenPayload.scope || OAUTH_SCOPE,
        email: profile.email,
        name: profile.name,
        sub: profile.sub,
        planType: profile.planType,
        updatedAt: new Date().toISOString(),
      };
      saveAuth(latestAuth);
      modelCache = { fetchedAt: 0, tokenKey: '', models: [] };

      return {
        statusCode: 200,
        html: renderCallbackHtml({
          ok: true,
          title: 'Connected to ChatGPT Subscription',
          detail: `Signed in${profile.email ? ` as ${profile.email}` : ''}. You can close this window and return to your terminal or IDE.`,
        }),
        sessionStatus: 'connected',
        sessionError: '',
        result: { ok: true, account: profile, clientId: finalClientId },
      };
    } catch (err) {
      const baseMsg = err instanceof Error ? err.message : String(err);
      const clientHint = issuedClientId ? `${issuedClientId.slice(0, 12)}...` : 'dynamic_agent_client';
      const statusHint = err?.status ? `http=${err.status}, ` : '';
      const msg = `${baseMsg} (${statusHint}client=${clientHint}, callback_client_id=${Boolean(callbackClientId)}, resource=${resourceUri})`;
      return {
        statusCode: 500,
        html: renderCallbackHtml({ ok: false, title: 'Token Exchange Failed', detail: msg }),
        sessionStatus: 'error',
        sessionError: msg,
        result: { ok: false, error: msg },
      };
    }
  };

  server.on('request', async (req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      if (reqUrl.pathname !== '/auth/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      if (callbackSettled) {
        res.writeHead(callbackSettled.statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(callbackSettled.html);
        return;
      }

      const isLeader = !callbackInFlight;
      if (isLeader) {
        callbackInFlight = runCallbackOnce(reqUrl).then((outcome) => {
          callbackSettled = outcome;
          return outcome;
        });
      }

      const settled = await callbackInFlight;
      res.writeHead(settled.statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
      await new Promise((resolveWrite) => {
        res.once('close', resolveWrite);
        res.end(settled.html, resolveWrite);
      });

      if (isLeader) {
        session.status = settled.sessionStatus;
        session.error = settled.sessionError;
        finish(settled.result);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        await new Promise((resolveWrite) => {
          res.once('close', resolveWrite);
          res.end(renderCallbackHtml({ ok: false, title: 'Token Exchange Failed', detail: msg }), resolveWrite);
        });
      } catch {
        // Ignore write failures.
      }
      session.status = 'error';
      session.error = msg;
      finish({ ok: false, error: msg });
    }
  });

  if (openBrowser) {
    openExternalUrl(authUrl);
  }

  return {
    authUrl,
    redirectUri,
    completionPromise,
  };
}

export function signOutChatGPT() {
  cancelPendingOAuth();
  lastLoginOutcome = null;
  clearOpenAIAuth();
  modelCache = { fetchedAt: 0, tokenKey: '', models: [] };
}

/**
 * Returns a valid Bearer token from either the ChatGPT OAuth session (auto-refreshing
 * safely under a cross-process file lock) or an explicit API key fallback.
 * @returns {Promise<{token: string, mode: 'oauth'|'api_key', account: Record<string, any>}>}
 */
export async function getValidOpenAIToken(fetchImpl = proxyFetch) {
  const auth = getAuth();

  if (auth.openai?.accessToken) {
    const expiresAt = Number(auth.openai.expiresAt || 0);
    if (Date.now() < expiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return {
        token: auth.openai.accessToken,
        mode: 'oauth',
        account: {
          email: auth.openai.email || '',
          name: auth.openai.name || '',
          planType: auth.openai.planType || '',
          expiresAt,
        },
      };
    }

    if (!auth.openai.refreshToken || !auth.openai.clientId) {
      throw new Error(
        'ChatGPT OAuth session expired and cannot be refreshed. Please sign in again in GOAT Harness.'
      );
    }

    return withFileLock('oauth-refresh', async () => {
      const freshAuth = getAuth();
      const current = freshAuth.openai;
      if (!current?.accessToken) {
        throw new Error('ChatGPT OAuth session was cleared. Please sign in again.');
      }
      const currentExpiry = Number(current.expiresAt || 0);
      if (Date.now() < currentExpiry - TOKEN_REFRESH_MARGIN_MS) {
        return {
          token: current.accessToken,
          mode: 'oauth',
          account: {
            email: current.email || '',
            name: current.name || '',
            planType: current.planType || '',
            expiresAt: currentExpiry,
          },
        };
      }

      const settings = getSettings();
      const endpoints = await getOidcEndpoints(settings.authBaseUrl, fetchImpl);
      try {
        const refreshed = await refreshAccessToken({
          tokenEndpoint: endpoints.tokenEndpoint,
          clientId: current.clientId,
          refreshToken: current.refreshToken,
          resource: settings.apiBaseUrl || 'https://api.openai.com/v1',
          fetchImpl,
        });
        const expiresInSec = Number(refreshed.expires_in) || 3600;
        const profile = extractAccountProfile(
          refreshed.id_token || current.idToken,
          refreshed.access_token
        );

        freshAuth.openai = {
          ...current,
          clientId: refreshed.client_id || current.clientId,
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token || current.refreshToken,
          idToken: refreshed.id_token || current.idToken,
          expiresAt: Date.now() + expiresInSec * 1000,
          email: profile.email || current.email,
          name: profile.name || current.name,
          planType: profile.planType || current.planType,
          updatedAt: new Date().toISOString(),
        };
        saveAuth(freshAuth);

        return {
          token: freshAuth.openai.accessToken,
          mode: 'oauth',
          account: {
            email: freshAuth.openai.email || '',
            name: freshAuth.openai.name || '',
            planType: freshAuth.openai.planType || '',
            expiresAt: freshAuth.openai.expiresAt,
          },
        };
      } catch (err) {
        if (
          err?.code === 'refresh_token_reused' ||
          err?.code === 'invalid_grant' ||
          err?.code === 'invalid_client'
        ) {
          clearOpenAIAuth();
        }
        throw new Error(
          `ChatGPT token refresh failed (${err.message}). Please sign in again via GOAT Harness UI.`
        );
      }
    });
  }

  const fallbackKey = auth.apiKeyFallback || process.env.OPENAI_API_KEY || '';
  if (fallbackKey) {
    return {
      token: fallbackKey,
      mode: 'api_key',
      account: { email: '', name: 'API Key', planType: 'api_key', expiresAt: 0 },
    };
  }

  throw new Error(
    'Not signed in to ChatGPT. Open the GOAT Harness auxiliary panel and click "Sign in with ChatGPT".'
  );
}

function normalizeReasoningLevels(levels) {
  if (!Array.isArray(levels)) return [];
  const out = [];
  for (const item of levels) {
    const val = typeof item === 'string' ? item : item?.effort || item?.level || item?.name || '';
    const trimmed = String(val || '').trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * Normalizes /v1/models payloads from both Sign-in-with-ChatGPT (`models[]`) and
 * standard OpenAI API keys (`data[]`).
 * @param {Record<string, any>} payload
 * @returns {Array<{
 *   slug: string,
 *   displayName: string,
 *   visibility: string,
 *   description?: string,
 *   contextWindow?: number,
 *   maxContextWindow?: number,
 *   defaultReasoningLevel?: string,
 *   supportedReasoningLevels?: string[],
 *   supportsSearchTool?: boolean,
 *   supportsReasoningSummary?: boolean,
 *   priority?: number,
 * }>}
 */
export function normalizeModelsPayload(payload) {
  if (Array.isArray(payload?.models)) {
    const listed = payload.models.filter((m) => m && m.visibility === 'list');
    const source = listed.length ? listed : payload.models;
    return source
      .filter((m) => m?.slug || m?.id)
      .map((m) => {
        const entry = {
          slug: String(m.slug || m.id),
          displayName: String(m.display_name || m.slug || m.id),
          visibility: String(m.visibility || 'list'),
        };
        if (m.description) entry.description = String(m.description);
        if (Number.isFinite(Number(m.context_window)) && Number(m.context_window) > 0) {
          entry.contextWindow = Number(m.context_window);
        }
        if (Number.isFinite(Number(m.max_context_window)) && Number(m.max_context_window) > 0) {
          entry.maxContextWindow = Number(m.max_context_window);
        }
        if (m.default_reasoning_level) {
          entry.defaultReasoningLevel = String(m.default_reasoning_level);
        }
        const levels = normalizeReasoningLevels(m.supported_reasoning_levels);
        if (levels.length) entry.supportedReasoningLevels = levels;
        if (typeof m.supports_search_tool === 'boolean') {
          entry.supportsSearchTool = m.supports_search_tool;
        }
        if (typeof m.supports_reasoning_summary_parameter === 'boolean') {
          entry.supportsReasoningSummary = m.supports_reasoning_summary_parameter;
        }
        if (Number.isFinite(Number(m.priority))) {
          entry.priority = Number(m.priority);
        }
        return entry;
      });
  }

  if (Array.isArray(payload?.data)) {
    return payload.data
      .filter((m) => m?.id)
      .map((m) => ({
        slug: String(m.id),
        displayName: String(m.id),
        visibility: 'list',
      }));
  }

  return [];
}

const KNOWN_MODEL_CONTEXT_WINDOWS = new Map([
  ['gpt-6.1-sol', 500000],
  ['gpt-6.1-terra', 500000],
  ['gpt-6-astra', 272000],
  ['gpt-6-sol', 272000],
  ['gpt-6-luna', 272000],
  ['gpt-5.6-sol', 272000],
  ['gpt-5.6-terra', 272000],
  ['gpt-5.6-luna', 272000],
]);

/**
 * Resolves the safe input context window for an OpenAI model slug so Claude Code
 * compacts accurately before hitting upstream limits.
 */
export function resolveModelContextWindow(models = [], modelSlug = '') {
  const slug = String(modelSlug || '').trim();
  if (!slug) return 0;
  const hit = Array.isArray(models) ? models.find((m) => m?.slug === slug) : null;
  if (Number.isFinite(Number(hit?.contextWindow)) && Number(hit.contextWindow) > 0) {
    return Number(hit.contextWindow);
  }
  return KNOWN_MODEL_CONTEXT_WINDOWS.get(slug) || 0;
}

/**
 * Builds Anthropic -> OpenAI model tier assignments so Claude Code's built-in `/model`
 * menu (`opus`, `sonnet`, `haiku`) maps cleanly to distinct ChatGPT models (e.g. `gpt-6-astra`
 * for Opus, `gpt-6.1-sol` for Sonnet, `gpt-6-luna` for Haiku) while honoring `selectedModel`.
 * @param {Array<{slug: string}>} models
 * @param {string} [selectedModel]
 * @returns {{ default: string, opus: string, sonnet: string, haiku: string }}
 */
export function selectModelTiers(models = [], selectedModel = '') {
  const slugs = (Array.isArray(models) ? models : [])
    .map((m) => (typeof m === 'string' ? m : m?.slug))
    .filter(Boolean);
  const fallback = String(selectedModel || '').trim() || slugs[0] || '';

  const pick = (matchers, fb = fallback) => {
    for (const matcher of matchers) {
      const hit =
        typeof matcher === 'string'
          ? slugs.find((s) => s === matcher)
          : slugs.find((s) => matcher.test(s));
      if (hit) return hit;
    }
    return fb;
  };

  return {
    default: fallback,
    opus: pick(['gpt-6-astra', /^gpt-6.*astra/i, 'gpt-6.1-terra', /^gpt-.*terra/i]),
    sonnet: pick(
      selectedModel && !/luna|astra/i.test(selectedModel)
        ? [selectedModel, 'gpt-6.1-sol', /^gpt-6\.1-sol/i, 'gpt-6-sol']
        : ['gpt-6.1-sol', /^gpt-6\.1-sol/i, 'gpt-6-sol']
    ),
    haiku: pick(['gpt-6-luna', 'gpt-5.6-luna', /luna|mini|nano|haiku/i]),
  };
}

/**
 * Resolves the effective startup model plus Anthropic tier map (`opus`, `sonnet`, `haiku`)
 * from requested overrides, saved settings, and live `/v1/models` catalog metadata.
 */
export async function resolveLaunchModelConfig({
  requestedModel = '',
  defaultModel = '',
  getModelsFn = fetchOpenAIModels,
  fetchImpl = proxyFetch,
} = {}) {
  let selectedModel = String(requestedModel || defaultModel || '').trim();
  let models = [];

  try {
    const catalog = await getModelsFn({ fetchImpl });
    models = Array.isArray(catalog?.models) ? catalog.models : [];
    if (!selectedModel) {
      selectedModel = models[0]?.slug || '';
    }
  } catch (err) {
    if (!selectedModel) throw err;
  }

  return {
    selectedModel,
    models,
    tiers: selectModelTiers(models, selectedModel),
    contextWindow: resolveModelContextWindow(models, selectedModel),
  };
}

export async function fetchOpenAIModels({ forceRefresh = false, fetchImpl = proxyFetch } = {}) {
  const { token, mode, account } = await getValidOpenAIToken(fetchImpl);
  const tokenKey = `${mode}:${token.slice(-12)}`;
  if (!forceRefresh && modelCache.tokenKey === tokenKey && Date.now() - modelCache.fetchedAt < MODEL_CACHE_TTL_MS) {
    return { models: modelCache.models, mode, account };
  }

  const settings = getSettings();
  const base = String(settings.apiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const res = await fetchImpl(`${base}/models`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to fetch OpenAI models (HTTP ${res.status}): ${body}`);
  }

  const json = await res.json();
  const models = normalizeModelsPayload(json);
  modelCache = { fetchedAt: Date.now(), tokenKey, models };
  return { models, mode, account };
}

export function getAuthSummary() {
  const auth = getAuth();
  const hasOAuth = Boolean(auth.openai?.accessToken);
  const hasApiKey = Boolean(auth.apiKeyFallback || process.env.OPENAI_API_KEY);
  return {
    connected: hasOAuth || hasApiKey,
    mode: hasOAuth ? 'oauth' : hasApiKey ? 'api_key' : 'none',
    hostId: auth.hostId || '',
    account: hasOAuth
      ? {
          email: auth.openai.email || '',
          name: auth.openai.name || '',
          planType: auth.openai.planType || '',
          clientId: auth.openai.clientId || '',
          expiresAt: auth.openai.expiresAt || 0,
        }
      : null,
    hasApiKeyFallback: Boolean(auth.apiKeyFallback),
    pendingOAuth: getPendingOAuthStatus(),
  };
}
