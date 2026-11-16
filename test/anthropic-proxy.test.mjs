import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startAnthropicProxy } from '../lib/anthropic-proxy.mjs';
import { parseSseStream } from '../lib/openai-responses.mjs';
import { formatMonitorScreen, runProxyMonitor } from '../lib/proxy-monitor.mjs';
import { getUsageSummary, recordUsageEvent, resetUsageStats, saveSettings } from '../lib/store.mjs';

function sseStreamFromEvents(events) {
  const text = events
    .map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)
    .join('');
  return new Response(text, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

test('anthropic-proxy handles auth, count_tokens, streaming SSE, non-streaming JSON, and 400 fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goat-proxy-test-'));
  process.env.GOAT_HARNESS_HOME = dir;

  let attempts = 0;
  const mockFetch = async (url, init) => {
    if (String(url).endsWith('/responses')) {
      attempts += 1;
      const body = JSON.parse(init.body);
      assert.equal(body.store, false);
      assert.equal(body.stream, true);

      // Simulate a model rejecting `reasoning` parameter on the first call, verifying clean fallback retry.
      if (attempts === 1 && body.reasoning) {
        return new Response('Unsupported parameter: reasoning', { status: 400 });
      }

      return sseStreamFromEvents([
        { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
        { type: 'response.output_text.delta', delta: 'Hello from OpenAI!' },
        {
          type: 'response.completed',
          response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 10, output_tokens: 5 } },
        },
      ]);
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const proxy = await startAnthropicProxy({
    defaultModel: 'gpt-5-codex',
    reasoningEffort: 'medium',
    getTokenFn: async () => ({ token: 'tok_abc', mode: 'oauth', account: {} }),
    getModelsFn: async () => ({
      models: [{ slug: 'gpt-5-codex', displayName: 'GPT-5 Codex', visibility: 'list' }],
    }),
    fetchImpl: mockFetch,
  });

  try {
    // Rejects missing auth token
    const unauthRes = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(unauthRes.status, 401);

    // count_tokens works
    const countRes = await fetch(`${proxy.baseUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': proxy.token },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello world' }] }),
    });
    assert.equal(countRes.status, 200);
    const countJson = await countRes.json();
    assert.ok(countJson.input_tokens > 0);

    // Streaming /v1/messages (also exercises reasoning 400 fallback)
    const streamRes = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': proxy.token },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(streamRes.status, 200);
    assert.equal(attempts, 2);

    const sseEvents = [];
    for await (const ev of parseSseStream(streamRes.body)) {
      sseEvents.push(ev);
    }
    assert.equal(sseEvents[0].event, 'message_start');
    assert.ok(
      sseEvents.some(
        (e) => e.event === 'content_block_delta' && e.data?.delta?.text === 'Hello from OpenAI!'
      )
    );
    assert.equal(sseEvents.at(-1).event, 'message_stop');

    // Non-streaming /v1/messages returns full Anthropic Message JSON
    const jsonRes = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${proxy.token}` },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(jsonRes.status, 200);
    const msgJson = await jsonRes.json();
    assert.equal(msgJson.type, 'message');
    assert.equal(msgJson.stop_reason, 'end_turn');
    assert.equal(msgJson.content[0].text, 'Hello from OpenAI!');
  } finally {
    await proxy.close();
    delete process.env.GOAT_HARNESS_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('anthropic-proxy records per-model usage ledger, routes model tiers, and logs 429 quota errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goat-proxy-usage-test-'));
  process.env.GOAT_HARNESS_HOME = dir;

  let force429 = false;
  const requestedModels = [];
  const mockFetch = async (url, init) => {
    if (String(url).endsWith('/responses')) {
      const parsed = JSON.parse(init.body);
      requestedModels.push(parsed.model);
      if (force429) {
        return new Response('Rate limit exceeded for gpt-6-astra', {
          status: 429,
          headers: { 'retry-after': '12' },
        });
      }
      return sseStreamFromEvents([
        { type: 'response.output_text.delta', delta: 'Astra ok' },
        {
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 300,
              input_tokens_details: { cached_tokens: 200 },
              output_tokens: 50,
              output_tokens_details: { reasoning_tokens: 30 },
              total_tokens: 350,
            },
          },
        },
      ]);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const proxy = await startAnthropicProxy({
    defaultModel: 'gpt-6.1-sol',
    modelTiers: {
      default: 'gpt-6.1-sol',
      opus: 'gpt-6-astra',
      sonnet: 'gpt-6.1-sol',
      haiku: 'gpt-6-luna',
    },
    reasoningEffort: 'xhigh',
    getTokenFn: async () => ({ token: 'test_tok', mode: 'oauth', account: {} }),
    fetchImpl: mockFetch,
  });

  try {
    const res1 = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${proxy.token}` },
      body: JSON.stringify({
        model: 'opus',
        stream: false,
        messages: [{ role: 'user', content: 'Use astra' }],
      }),
    });
    assert.equal(res1.status, 200);
    assert.equal(requestedModels[0], 'gpt-6-astra');

    const summaryAfterSuccess = getUsageSummary();
    assert.equal(summaryAfterSuccess.allTime.requests, 1);
    assert.equal(summaryAfterSuccess.allTime.totalTokens, 350);
    assert.equal(summaryAfterSuccess.byModel['gpt-6-astra'].cachedTokens, 200);
    assert.equal(summaryAfterSuccess.byModel['gpt-6-astra'].reasoningTokens, 30);

    // Record an historical bucket 10 days ago to verify today vs 7d vs 30d window slicing.
    const now = Date.now();
    await recordUsageEvent({
      model: 'gpt-6.1-sol',
      inputTokens: 100,
      outputTokens: 20,
      timestamp: now - 10 * 86_400_000,
    });
    const windowed = getUsageSummary({ now });
    assert.equal(windowed.today.totalTokens, 350);
    assert.equal(windowed.last7Days.totalTokens, 350);
    assert.equal(windowed.last30Days.totalTokens, 470);
    assert.equal(windowed.allTime.totalTokens, 470);

    force429 = true;
    const res429 = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${proxy.token}` },
      body: JSON.stringify({
        model: 'gpt-6-astra',
        stream: false,
        messages: [{ role: 'user', content: 'Hit rate limit' }],
      }),
    });
    assert.equal(res429.status, 429);
    const afterQuota = getUsageSummary();
    assert.equal(afterQuota.lastQuotaError.status, 429);
    assert.equal(afterQuota.lastQuotaError.model, 'gpt-6-astra');
    assert.equal(afterQuota.lastQuotaError.retryAfter, '12');

    await resetUsageStats();
    assert.equal(getUsageSummary().allTime.requests, 0);
  } finally {
    await proxy.close();
    delete process.env.GOAT_HARNESS_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('anthropic-proxy dynamicSettings reloads defaultModel and reasoningEffort without restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goat-proxy-dyn-'));
  process.env.GOAT_HARNESS_HOME = dir;

  saveSettings({ defaultModel: 'gpt-6.1-sol', reasoningEffort: 'low' });
  const observedPayloads = [];
  const mockFetch = async (_url, init) => {
    observedPayloads.push(JSON.parse(init.body));
    return sseStreamFromEvents([
      { type: 'response.created', response: { id: 'resp_dyn', status: 'in_progress' } },
      { type: 'response.output_text.delta', delta: 'dyn_ok' },
      { type: 'response.completed', response: { id: 'resp_dyn', status: 'completed', usage: { input_tokens: 4, output_tokens: 2 } } },
    ]);
  };

  const proxy = await startAnthropicProxy({
    dynamicSettings: true,
    token: 'fixed-daemon-token',
    getTokenFn: async () => ({ token: 'tok', mode: 'oauth', account: {} }),
    getModelsFn: async () => ({
      models: [
        { slug: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', visibility: 'list' },
        { slug: 'gpt-6-astra', displayName: 'GPT-6 Astra', visibility: 'list' },
        { slug: 'gpt-6-luna', displayName: 'GPT-6 Luna', visibility: 'list' },
      ],
    }),
    fetchImpl: mockFetch,
  });

  try {
    const healthRes = await fetch(`${proxy.baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.equal(health.dynamicSettings, true);
    assert.equal(proxy.token, 'fixed-daemon-token');

    await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${proxy.token}` },
      body: JSON.stringify({ model: 'claude-default', stream: false, messages: [{ role: 'user', content: 'first' }] }),
    });

    // Update persisted default model & reasoning effort while proxy stays running.
    saveSettings({ defaultModel: 'gpt-6-astra', reasoningEffort: 'high' });

    await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${proxy.token}` },
      body: JSON.stringify({ model: 'claude-default', stream: false, messages: [{ role: 'user', content: 'second' }] }),
    });

    assert.equal(observedPayloads.length, 2);
    assert.equal(observedPayloads[0].model, 'gpt-6.1-sol');
    assert.equal(observedPayloads[0].reasoning?.effort, 'low');
    assert.equal(observedPayloads[1].model, 'gpt-6-astra');
    assert.equal(observedPayloads[1].reasoning?.effort, 'high');
  } finally {
    await proxy.close();
    delete process.env.GOAT_HARNESS_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('anthropic-proxy defaults omitted stream to JSON, caps base64 count_tokens bloat, and passes 400/413 context errors cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goat-proxy-compat-'));
  process.env.GOAT_HARNESS_HOME = dir;

  let mode = 'ok';
  const mockFetch = async () => {
    if (mode === 'ctx_overflow') {
      return new Response(
        JSON.stringify({
          error: {
            message: 'Your input exceeds the context window of this model.',
            type: 'invalid_request_error',
            code: 'context_length_exceeded',
          },
        }),
        { status: 400 }
      );
    }
    return sseStreamFromEvents([
      { type: 'response.output_text.delta', delta: '<block>no</block>' },
      { type: 'response.completed', response: { usage: { input_tokens: 50, output_tokens: 6 } } },
    ]);
  };

  const proxy = await startAnthropicProxy({
    defaultModel: 'gpt-6.1-sol',
    getTokenFn: async () => ({ token: 'tok', mode: 'oauth', account: {} }),
    fetchImpl: mockFetch,
  });

  try {
    // Omitted `stream` MUST return JSON (fixing Anthropic SDK non-streaming callers like Auto Mode classifier)
    const noStreamRes = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${proxy.token}` },
      body: JSON.stringify({
        model: 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'Classify action' }],
      }),
    });
    assert.equal(noStreamRes.status, 200);
    assert.match(noStreamRes.headers.get('content-type') || '', /application\/json/);
    const msg = await noStreamRes.json();
    assert.equal(msg.type, 'message');
    assert.equal(msg.usage.input_tokens, 50);
    assert.equal(msg.content[0].text, '<block>no</block>');

    // Giant base64 PDF in count_tokens must not inflate linearly at 4 chars/token
    const hugeBase64 = 'A'.repeat(400_000);
    const countRes = await fetch(`${proxy.baseUrl}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${proxy.token}` },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: hugeBase64 } },
            ],
          },
        ],
      }),
    });
    assert.equal(countRes.status, 200);
    const countJson = await countRes.json();
    assert.ok(countJson.input_tokens < 10_000, `Expected bounded base64 estimate, got ${countJson.input_tokens}`);

    // Upstream context_length_exceeded translates to 400 `prompt is too long:` instead of 500
    mode = 'ctx_overflow';
    const ctxRes = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${proxy.token}` },
      body: JSON.stringify({
        model: 'gpt-6.1-sol',
        stream: false,
        messages: [{ role: 'user', content: 'Too long' }],
      }),
    });
    assert.equal(ctxRes.status, 400);
    const ctxJson = await ctxRes.json();
    assert.equal(ctxJson.error.type, 'invalid_request_error');
    assert.match(ctxJson.error.message, /^prompt is too long:/);
  } finally {
    await proxy.close();
    delete process.env.GOAT_HARNESS_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('anthropic-proxy exposes auth-protected telemetry snapshot and monitor formatter renders live metrics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goat-proxy-monitor-test-'));
  process.env.GOAT_HARNESS_HOME = dir;

  let callCount = 0;
  const proxy = await startAnthropicProxy({
    defaultModel: 'gpt-6.1-sol',
    modelTiers: {
      default: 'gpt-6.1-sol',
      opus: 'gpt-6-astra',
      sonnet: 'gpt-6.1-sol',
      haiku: 'gpt-6-luna',
    },
    reasoningEffort: 'xhigh',
    getTokenFn: async () => ({ token: 'tok', mode: 'oauth', account: {} }),
    fetchImpl: async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({ error: { message: 'Unsupported parameter: max_output_tokens' } }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        );
      }
      return sseStreamFromEvents([
        {
          type: 'response.output_item.done',
          item: {
            id: 'ws_m1',
            type: 'web_search_call',
            status: 'completed',
            action: { type: 'search', query: 'node test' },
          },
        },
        { type: 'response.output_text.delta', delta: 'Monitor ok' },
        {
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 1000,
              input_tokens_details: { cached_tokens: 800 },
              output_tokens: 120,
              output_tokens_details: { reasoning_tokens: 40 },
              total_tokens: 1120,
            },
          },
        },
      ]);
    },
  });

  try {
    const unauthSnap = await fetch(`${proxy.baseUrl}/_goat/snapshot`);
    assert.equal(unauthSnap.status, 401);

    const reqRes = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${proxy.token}` },
      body: JSON.stringify({
        model: 'haiku',
        max_tokens: 1024,
        stream: true,
        messages: [{ role: 'user', content: 'Quick check' }],
      }),
    });
    assert.equal(reqRes.status, 200);
    await reqRes.text();

    const snap = proxy.getMonitorSnapshot();
    assert.equal(snap.stats.totalRequests, 1);
    assert.equal(snap.stats.activeRequests, 0);
    assert.equal(snap.stats.completedRequests, 1);
    assert.equal(snap.stats.fallbackRecoveredRequests, 1);
    assert.equal(snap.stats.webSearchCalls, 1);
    assert.equal(snap.stats.cacheHitPct, 80);
    assert.equal(snap.recent[0].targetModel, 'gpt-6-luna');
    assert.equal(snap.recent[0].effort, 'low');
    assert.equal(snap.recent[0].fastTier, true);

    const rendered = formatMonitorScreen(snap, {
      baseUrl: proxy.baseUrl,
      account: 'user@example.com',
      defaultModel: 'gpt-6.1-sol',
      reasoningEffort: 'xhigh',
    });
    assert.match(rendered, /GOAT Proxy Monitor/);
    assert.match(rendered, /gpt-6-luna/);
    assert.match(rendered, /low\*/);
    assert.match(rendered, /1 auto-400-fixed/);

    let out = '';
    const monitorCode = await runProxyMonitor({
      once: true,
      json: true,
      baseUrl: proxy.baseUrl,
      token: proxy.token,
      stdout: { write: (s) => (out += s) },
      stderr: { write: () => {} },
    });
    assert.equal(monitorCode, 0);
    assert.equal(JSON.parse(out).stats.completedRequests, 1);
  } finally {
    await proxy.close();
    delete process.env.GOAT_HARNESS_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});
