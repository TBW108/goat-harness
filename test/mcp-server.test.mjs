import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMcpDispatcher } from '../lib/mcp-server.mjs';

test('MCP dispatcher handles initialize, tools/list, status, review, and run calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goat-mcp-test-'));
  process.env.GOAT_HARNESS_HOME = dir;

  try {
    let capturedArgs = null;
    const dispatch = createMcpDispatcher({
      getAuthSummary: () => ({ connected: true, mode: 'oauth', account: { email: 'a@b.com' } }),
      checkClaudeHealth: () => ({ available: true, path: '/usr/local/bin/claude', version: '2.1.322' }),
      fetchOpenAIModels: async () => ({
        mode: 'oauth',
        account: { email: 'a@b.com' },
        models: [{ slug: 'gpt-5-codex', displayName: 'GPT-5 Codex', visibility: 'list' }],
      }),
      runClaudeHarness: async (opts) => {
        capturedArgs = opts;
        return {
          id: 'run_123',
          status: 'completed',
          model: 'gpt-5-codex',
          claudeSessionId: 'sess_1',
          durationMs: 250,
          numTurns: 1,
          toolsUsed: [],
          usage: { input_tokens: 10, output_tokens: 20 },
          resultText: 'Looks clean.',
        };
      },
    });

    const init = await dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    });
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.equal(init.result.serverInfo.name, 'goat-harness-claude');

    const listed = await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(listed.result.tools.length, 9);
    assert.ok(listed.result.tools.some((t) => t.name === 'goat_login_chatgpt'));
    assert.ok(listed.result.tools.some((t) => t.name === 'goat_logout_chatgpt'));
    assert.ok(listed.result.tools.some((t) => t.name === 'goat_set_model'));
    assert.ok(listed.result.tools.some((t) => t.name === 'goat_usage'));

    const review = await dispatch({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'goat_review_with_openai',
        arguments: { focus: 'Check auth edge cases', cwd: '/tmp/proj' },
      },
    });
    assert.equal(capturedArgs.permissionMode, 'plan');
    assert.equal(capturedArgs.cwd, '/tmp/proj');
    const reviewPayload = JSON.parse(review.result.content[0].text);
    assert.equal(reviewPayload.review, 'Looks clean.');
  } finally {
    delete process.env.GOAT_HARNESS_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP stdio entrypoint speaks NDJSON over stdin/stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goat-mcp-stdio-'));
  try {
    const child = spawn('node', ['lib/mcp-server.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, GOAT_HARNESS_HOME: dir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const responses = [];
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const l of lines) {
        if (l.trim()) responses.push(JSON.parse(l));
      }
    });

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);

    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('MCP stdio timeout')), 5000);
      const iv = setInterval(() => {
        if (responses.length >= 2) {
          clearInterval(iv);
          clearTimeout(deadline);
          resolve();
        }
      }, 20);
    });

    assert.equal(responses[0].id, 1);
    assert.equal(responses[1].id, 2);
    assert.ok(responses[1].result.tools.some((t) => t.name === 'goat_run_claude_harness'));
    child.kill('SIGTERM');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP stdio entrypoint starts cleanly when invoked via symlinked plugin root', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goat-mcp-symlink-'));
  try {
    const linkedPlugin = join(dir, 'goat-harness-link');
    symlinkSync(process.cwd(), linkedPlugin);

    const child = spawn('node', [join(linkedPlugin, 'lib/mcp-server.mjs')], {
      cwd: linkedPlugin,
      env: { ...process.env, GOAT_HARNESS_HOME: dir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const responses = [];
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const l of lines) {
        if (l.trim()) responses.push(JSON.parse(l));
      }
    });

    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`
    );

    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Symlink MCP stdio timeout')), 5000);
      const iv = setInterval(() => {
        if (responses.length >= 1) {
          clearInterval(iv);
          clearTimeout(deadline);
          resolve();
        }
      }, 20);
    });

    assert.equal(responses[0].id, 1);
    assert.equal(responses[0].result.serverInfo.name, 'goat-harness-claude');
    child.kill('SIGTERM');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MCP dispatcher supports goat_login_chatgpt start/wait/cancel, goat_set_model, and goat_logout_chatgpt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goat-mcp-login-test-'));
  process.env.GOAT_HARNESS_HOME = dir;

  try {
    let signedIn = false;
    let cancelled = false;
    const dispatch = createMcpDispatcher({
      getAuthSummary: () =>
        signedIn
          ? { connected: true, mode: 'oauth', account: { email: 'u@example.com', planType: 'pro' } }
          : { connected: false, mode: 'none', account: null },
      startSignInWithChatGPT: async ({ openBrowser }) => {
        assert.equal(openBrowser, false);
        return {
          authUrl: 'https://auth.openai.com/authorize?state=abc',
          redirectUri: 'http://127.0.0.1:41234/auth/callback',
          completionPromise: Promise.resolve({ ok: true }),
        };
      },
      waitForPendingOAuth: async () => {
        signedIn = true;
        return { ok: true, account: { email: 'u@example.com', planType: 'pro' } };
      },
      cancelPendingOAuth: () => {
        cancelled = true;
      },
      signOutChatGPT: () => {
        signedIn = false;
      },
      fetchOpenAIModels: async () => ({
        mode: 'oauth',
        account: { email: 'u@example.com' },
        models: [{ slug: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', visibility: 'list' }],
      }),
    });

    const startRes = await dispatch({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'goat_login_chatgpt',
        arguments: { action: 'start', open_browser: false },
      },
    });
    const startJson = JSON.parse(startRes.result.content[0].text);
    assert.equal(startJson.status, 'pending');
    assert.equal(startJson.auth_url, 'https://auth.openai.com/authorize?state=abc');

    const waitRes = await dispatch({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: 'goat_login_chatgpt',
        arguments: { action: 'wait', wait_sec: 15 },
      },
    });
    const waitJson = JSON.parse(waitRes.result.content[0].text);
    assert.equal(waitJson.status, 'connected');
    assert.equal(waitJson.account.email, 'u@example.com');
    assert.equal(waitJson.models[0].slug, 'gpt-5.3-codex');

    const alreadyRes = await dispatch({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: {
        name: 'goat_login_chatgpt',
        arguments: { action: 'start' },
      },
    });
    const alreadyJson = JSON.parse(alreadyRes.result.content[0].text);
    assert.equal(alreadyJson.status, 'already_connected');

    const setModelRes = await dispatch({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: {
        name: 'goat_set_model',
        arguments: { model: 'gpt-6-astra', reasoning_effort: 'xhigh' },
      },
    });
    const setModelJson = JSON.parse(setModelRes.result.content[0].text);
    assert.equal(setModelJson.ok, true);
    assert.equal(setModelJson.settings.defaultModel, 'gpt-6-astra');
    assert.equal(setModelJson.settings.reasoningEffort, 'xhigh');

    const usageRes = await dispatch({
      jsonrpc: '2.0',
      id: 16,
      method: 'tools/call',
      params: { name: 'goat_usage', arguments: { reset: true } },
    });
    const usageJson = JSON.parse(usageRes.result.content[0].text);
    assert.equal(usageJson.reset, true);
    assert.equal(usageJson.usage.chatgptUsageSettingsUrl, 'https://chatgpt.com/#settings');

    const cancelRes = await dispatch({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: { name: 'goat_login_chatgpt', arguments: { action: 'cancel' } },
    });
    assert.equal(JSON.parse(cancelRes.result.content[0].text).status, 'cancelled');
    assert.equal(cancelled, true);

    const logoutRes = await dispatch({
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: { name: 'goat_logout_chatgpt', arguments: {} },
    });
    const logoutJson = JSON.parse(logoutRes.result.content[0].text);
    assert.equal(logoutJson.status, 'signed_out');
    assert.equal(logoutJson.auth.connected, false);
  } finally {
    delete process.env.GOAT_HARNESS_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});
