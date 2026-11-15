import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildAuthorizationUrl,
  generatePkcePair,
  getValidOpenAIToken,
  normalizeModelsPayload,
  selectModelTiers,
  signOutChatGPT,
  startSignInWithChatGPT,
  waitForPendingOAuth,
} from '../lib/openai-oauth.mjs';
import { getAuth, saveAuth } from '../lib/store.mjs';

function makeTempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'goat-oauth-test-'));
  process.env.GOAT_HARNESS_HOME = dir;
  return dir;
}

function makeFakeJwt(claims) {
  const hdr = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${hdr}.${body}.sig`;
}

test('generatePkcePair produces valid S256 challenge', () => {
  const { codeVerifier, codeChallenge } = generatePkcePair();
  const expected = createHash('sha256').update(codeVerifier).digest('base64url');
  assert.equal(codeChallenge, expected);
  assert.ok(codeVerifier.length >= 40);
});

test('buildAuthorizationUrl sets dynamic_agent_client and ChatGPT plan scopes', () => {
  const raw = buildAuthorizationUrl({
    authorizationEndpoint: 'https://auth.openai.com/api/accounts/authorize',
    clientId: '',
    hostId: 'urn:uuid:11111111-2222-3333-4444-555555555555',
    redirectUri: 'http://127.0.0.1:49999/auth/callback',
    codeChallenge: 'abc123',
    state: 'st_1',
    nonce: 'nc_1',
  });
  const parsed = new URL(raw);
  assert.equal(parsed.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(parsed.searchParams.get('agent_name_hint'), 'GOAT Harness');
  assert.equal(
    parsed.searchParams.get('ext_agent_host_id'),
    'urn:uuid:11111111-2222-3333-4444-555555555555'
  );
  assert.equal(parsed.searchParams.get('resource'), 'https://api.openai.com/v1');
  assert.ok(parsed.searchParams.get('scope').includes('chatgpt.tokens.use.direct'));

  const reauth = new URL(
    buildAuthorizationUrl({
      authorizationEndpoint: 'https://auth.openai.com/api/accounts/authorize',
      clientId: 'oaiapp_existing_123',
      hostId: 'urn:uuid:11111111-2222-3333-4444-555555555555',
      redirectUri: 'http://127.0.0.1:49999/auth/callback',
      codeChallenge: 'abc123',
      state: 'st_2',
      nonce: 'nc_2',
    })
  );
  assert.equal(reauth.searchParams.get('client_id'), 'oaiapp_existing_123');
  assert.equal(reauth.searchParams.get('agent_name_hint'), null);
});

test('loopback PKCE flow validates state, captures oaiapp client_id, and saves 0600 auth.json', async () => {
  const dir = makeTempHome();
  try {
    const fakeIdToken = makeFakeJwt({
      sub: 'user_123',
      email: 'dev@example.com',
      name: 'Dev User',
      'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' },
    });

    const mockFetch = async (url, init) => {
      if (String(url).includes('.well-known/openid-configuration')) {
        return new Response(
          JSON.stringify({
            authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
            token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
          }),
          { status: 200 }
        );
      }
      if (String(url).includes('/oauth/token')) {
        const params = new URLSearchParams(init.body);
        assert.equal(params.get('grant_type'), 'authorization_code');
        assert.equal(params.get('client_id'), 'oaiapp_issued_999');
        assert.equal(params.get('code'), 'authcode_xyz');
        assert.equal(params.get('resource'), 'https://api.openai.com/v1');
        return new Response(
          JSON.stringify({
            access_token: 'access_tok_1',
            refresh_token: 'refresh_tok_1',
            id_token: fakeIdToken,
            expires_in: 3600,
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const { authUrl, redirectUri, completionPromise } = await startSignInWithChatGPT({
      openBrowser: false,
      timeoutMs: 10_000,
      fetchImpl: mockFetch,
    });

    const stateParam = new URL(authUrl).searchParams.get('state');

    // First test CSRF state rejection (does not close server? Wait: server closes on invalid state -> check new session!)
    // Actually send valid callback directly, and check CSRF rejection in separate session below.
    const cbRes = await fetch(
      `${redirectUri}?code=authcode_xyz&state=${encodeURIComponent(stateParam)}&client_id=oaiapp_issued_999`
    );
    assert.equal(cbRes.status, 200);
    const done = await completionPromise;
    assert.equal(done.ok, true);
    assert.equal(done.clientId, 'oaiapp_issued_999');

    const stored = getAuth();
    assert.equal(stored.openai.accessToken, 'access_tok_1');
    assert.equal(stored.openai.refreshToken, 'refresh_tok_1');
    assert.equal(stored.openai.clientId, 'oaiapp_issued_999');
    assert.equal(stored.openai.email, 'dev@example.com');
    assert.equal(stored.openai.planType, 'pro');

    const mode = statSync(join(dir, 'auth.json')).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    delete process.env.GOAT_HARNESS_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loopback PKCE flow rejects mismatched CSRF state', async () => {
  const dir = makeTempHome();
  try {
    const mockFetch = async (url) => {
      if (String(url).includes('.well-known/openid-configuration')) {
        return new Response(
          JSON.stringify({
            authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
            token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
          }),
          { status: 200 }
        );
      }
      throw new Error(`Token exchange must not run on invalid state: ${url}`);
    };

    const { redirectUri, completionPromise } = await startSignInWithChatGPT({
      openBrowser: false,
      timeoutMs: 10_000,
      fetchImpl: mockFetch,
    });

    const cbRes = await fetch(`${redirectUri}?code=authcode_xyz&state=wrong_state`);
    assert.equal(cbRes.status, 400);
    const done = await completionPromise;
    assert.equal(done.ok, false);
    assert.match(done.error, /state mismatch/i);
  } finally {
    delete process.env.GOAT_HARNESS_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent getValidOpenAIToken refreshes once and preserves rotated refresh_token', async () => {
  const dir = makeTempHome();
  try {
    saveAuth({
      hostId: 'urn:uuid:test-host',
      openai: {
        clientId: 'oaiapp_test',
        accessToken: 'expired_tok',
        refreshToken: 'rt_1',
        idToken: '',
        expiresAt: Date.now() - 5000,
        email: 'dev@example.com',
      },
      apiKeyFallback: '',
    });

    let refreshCalls = 0;
    const mockFetch = async (url, init) => {
      if (String(url).includes('.well-known/openid-configuration')) {
        return new Response(
          JSON.stringify({
            authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
            token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
          }),
          { status: 200 }
        );
      }
      if (String(url).includes('/oauth/token')) {
        const params = new URLSearchParams(init.body);
        assert.equal(params.get('grant_type'), 'refresh_token');
        assert.equal(params.get('resource'), 'https://api.openai.com/v1');
        refreshCalls += 1;
        await new Promise((r) => setTimeout(r, 40));
        return new Response(
          JSON.stringify({
            access_token: 'fresh_tok_2',
            refresh_token: 'rt_2_rotated',
            expires_in: 3600,
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const [a, b] = await Promise.all([
      getValidOpenAIToken(mockFetch),
      getValidOpenAIToken(mockFetch),
    ]);

    assert.equal(refreshCalls, 1);
    assert.equal(a.token, 'fresh_tok_2');
    assert.equal(b.token, 'fresh_tok_2');
    assert.equal(getAuth().openai.refreshToken, 'rt_2_rotated');
  } finally {
    delete process.env.GOAT_HARNESS_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeModelsPayload handles both ChatGPT catalog and standard OpenAI list', () => {
  const chatgptCatalog = normalizeModelsPayload({
    models: [
      { slug: 'gpt-5-codex', display_name: 'GPT-5 Codex', visibility: 'list' },
      { slug: 'internal-hidden', display_name: 'Hidden', visibility: 'hide' },
      { slug: 'gpt-5', display_name: 'GPT-5', visibility: 'list' },
    ],
  });
  assert.deepEqual(chatgptCatalog, [
    { slug: 'gpt-5-codex', displayName: 'GPT-5 Codex', visibility: 'list' },
    { slug: 'gpt-5', displayName: 'GPT-5', visibility: 'list' },
  ]);

  const apiCatalog = normalizeModelsPayload({
    data: [{ id: 'gpt-4.1' }, { id: 'o4-mini' }],
  });
  assert.equal(apiCatalog.length, 2);
  assert.equal(apiCatalog[0].slug, 'gpt-4.1');
});

test('waitForPendingOAuth handles timeout without closing server and completes on callback', async () => {
  const dir = makeTempHome();
  try {
    const fakeIdToken = makeFakeJwt({
      sub: 'user_wait_1',
      email: 'wait@example.com',
      'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
    });

    const mockFetch = async (url) => {
      if (String(url).includes('.well-known/openid-configuration')) {
        return new Response(
          JSON.stringify({
            authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
            token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
          }),
          { status: 200 }
        );
      }
      if (String(url).includes('/oauth/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'wait_tok_1',
            refresh_token: 'wait_rt_1',
            id_token: fakeIdToken,
            expires_in: 3600,
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { authUrl, redirectUri } = await startSignInWithChatGPT({
      openBrowser: false,
      timeoutMs: 10_000,
      fetchImpl: mockFetch,
    });

    const timedOut = await waitForPendingOAuth(120);
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.pending, true);
    assert.equal(timedOut.authUrl, authUrl);

    const stateParam = new URL(authUrl).searchParams.get('state');
    const cbRes = await fetch(
      `${redirectUri}?code=code_wait&state=${encodeURIComponent(stateParam)}&client_id=oaiapp_wait`
    );
    assert.equal(cbRes.status, 200);

    // Callback already landed; waitForPendingOAuth should return lastLoginOutcome immediately.
    const completed = await waitForPendingOAuth(1000);
    assert.equal(completed.ok, true);
    assert.equal(completed.account.email, 'wait@example.com');

    signOutChatGPT();
    assert.equal(getAuth().openai, null);
  } finally {
    delete process.env.GOAT_HARNESS_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent duplicate /auth/callback requests only exchange code once', async () => {
  const dir = makeTempHome();
  try {
    const fakeIdToken = makeFakeJwt({
      sub: 'user_dup_1',
      email: 'dup@example.com',
      'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' },
    });

    let tokenCalls = 0;
    const mockFetch = async (url) => {
      if (String(url).includes('.well-known/openid-configuration')) {
        return new Response(
          JSON.stringify({
            authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
            token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
          }),
          { status: 200 }
        );
      }
      if (String(url).includes('/oauth/token')) {
        tokenCalls += 1;
        await new Promise((r) => setTimeout(r, 50));
        if (tokenCalls > 1) {
          return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
        }
        return new Response(
          JSON.stringify({
            access_token: 'dup_tok_1',
            refresh_token: 'dup_rt_1',
            id_token: fakeIdToken,
            expires_in: 3600,
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { authUrl, redirectUri, completionPromise } = await startSignInWithChatGPT({
      openBrowser: false,
      timeoutMs: 10_000,
      fetchImpl: mockFetch,
    });

    const stateParam = new URL(authUrl).searchParams.get('state');
    const cbUrl = `${redirectUri}?code=single_use_code&state=${encodeURIComponent(stateParam)}&client_id=oaiapp_dup`;
    const [res1, res2] = await Promise.all([fetch(cbUrl), fetch(cbUrl)]);

    assert.equal(res1.status, 200);
    assert.equal(res2.status, 200);
    assert.equal(tokenCalls, 1);

    const done = await completionPromise;
    assert.equal(done.ok, true);
    assert.equal(getAuth().openai.accessToken, 'dup_tok_1');
  } finally {
    delete process.env.GOAT_HARNESS_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeModelsPayload preserves rich metadata and selectModelTiers maps gpt-6-astra to opus', () => {
  const models = normalizeModelsPayload({
    models: [
      {
        slug: 'gpt-6.1-sol',
        display_name: 'GPT-6.1 Sol',
        visibility: 'list',
        context_window: 500000,
        max_context_window: 872000,
        default_reasoning_level: 'medium',
        supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      },
      {
        slug: 'gpt-6-astra',
        display_name: 'GPT-6 Astra',
        visibility: 'list',
        description: 'Flagship reasoning & coding model',
        context_window: 272000,
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'xhigh' }, { effort: 'ultra' }],
      },
      {
        slug: 'gpt-6-luna',
        display_name: 'GPT-6 Luna',
        visibility: 'list',
        context_window: 272000,
      },
    ],
  });

  assert.equal(models[0].contextWindow, 500000);
  assert.deepEqual(models[1].supportedReasoningLevels, ['low', 'xhigh', 'ultra']);
  assert.equal(models[1].description, 'Flagship reasoning & coding model');

  const tiersDefault = selectModelTiers(models, '');
  assert.deepEqual(tiersDefault, {
    default: 'gpt-6.1-sol',
    opus: 'gpt-6-astra',
    sonnet: 'gpt-6.1-sol',
    haiku: 'gpt-6-luna',
  });

  const tiersAstra = selectModelTiers(models, 'gpt-6-astra');
  assert.deepEqual(tiersAstra, {
    default: 'gpt-6-astra',
    opus: 'gpt-6-astra',
    sonnet: 'gpt-6.1-sol',
    haiku: 'gpt-6-luna',
  });
});
