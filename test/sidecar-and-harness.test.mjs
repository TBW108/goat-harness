import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveClaudeBinary, runClaudeHarness } from '../lib/claude-harness.mjs';
import { recordUsageEvent, saveAuth, saveRun, saveSettings } from '../lib/store.mjs';
import { createSidecarHandlers, startStandaloneServer } from '../sidecars/goat_harness_ui/main.mjs';

test('Sidecar standalone HTTP server serves UI, state, models, and settings updates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goat-sidecar-test-'));
  process.env.GOAT_HARNESS_HOME = dir;

  const handlers = createSidecarHandlers({
    fetchOpenAIModels: async () => ({
      mode: 'oauth',
      account: { email: 'user@example.com' },
      models: [{ slug: 'gpt-5-codex', displayName: 'GPT-5 Codex', visibility: 'list' }],
    }),
    runClaudeHarness: async ({ runId, prompt, cwd, model }) => {
      const done = {
        id: runId,
        source: 'sidecar',
        status: 'completed',
        model: model || 'gpt-5-codex',
        permissionMode: 'plan',
        cwd,
        prompt,
        claudeSessionId: 'sess_mock_1',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 12,
        resultText: 'Sidecar run ok',
        toolsUsed: [],
      };
      saveRun(done);
      return done;
    },
  });
  const srv = await startStandaloneServer(handlers, 0);

  try {
    const base = `http://127.0.0.1:${srv.port}`;

    const htmlRes = await fetch(`${base}/`);
    assert.equal(htmlRes.status, 200);
    assert.ok((await htmlRes.text()).includes('GOAT Harness'));

    const preloadRes = await fetch(`${base}/preload.js`);
    assert.equal(preloadRes.status, 200);

    const stateRes = await fetch(`${base}/api/state`);
    const stateJson = await stateRes.json();
    assert.equal(stateJson.auth.connected, false);

    const setRes = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        defaultModel: 'gpt-6-astra',
        permissionMode: 'plan',
        reasoningEffort: 'xhigh',
        strictVerifyHook: false,
      }),
    });
    const setJson = await setRes.json();
    assert.equal(setJson.ok, true);
    assert.equal(setJson.settings.defaultModel, 'gpt-6-astra');
    assert.equal(setJson.settings.permissionMode, 'plan');
    assert.equal(setJson.settings.reasoningEffort, 'xhigh');

    await recordUsageEvent({ model: 'gpt-6-astra', inputTokens: 90, outputTokens: 10 });
    const usageRes = await fetch(`${base}/api/usage`);
    const usageJson = await usageRes.json();
    assert.equal(usageJson.ok, true);
    assert.equal(usageJson.usage.allTime.totalTokens, 100);

    const resetRes = await fetch(`${base}/api/usage/reset`, { method: 'POST', body: '{}' });
    const resetJson = await resetRes.json();
    assert.equal(resetJson.ok, true);
    assert.equal(resetJson.usage.allTime.requests, 0);

    const modelsRes = await fetch(`${base}/api/models`);
    const modelsJson = await modelsRes.json();
    assert.equal(modelsJson.ok, true);
    assert.equal(modelsJson.models[0].slug, 'gpt-5-codex');

    const runStartRes = await fetch(`${base}/api/run/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Hello sidecar', cwd: dir, model: 'gpt-5-codex' }),
    });
    const runStartJson = await runStartRes.json();
    assert.equal(runStartJson.ok, true);
    assert.ok(runStartJson.runId);

    await new Promise((r) => setTimeout(r, 20));
    const detailRes = await fetch(`${base}/api/run?id=${encodeURIComponent(runStartJson.runId)}`);
    const detailJson = await detailRes.json();
    assert.equal(detailJson.ok, true);
    assert.equal(detailJson.run.resultText, 'Sidecar run ok');
  } finally {
    await srv.close();
    delete process.env.GOAT_HARNESS_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Real Claude Code CLI runs end-to-end through local proxy + mock OpenAI Responses SSE server', async (t) => {
  const claudeBin = resolveClaudeBinary();
  if (!claudeBin) {
    t.skip('claude CLI binary not installed');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'goat-e2e-claude-'));
  const workDir = join(dir, 'ws');
  const homeDir = join(dir, 'home');
  process.env.GOAT_HARNESS_HOME = homeDir;

  // Create tiny workspace file for Claude Code to read via tool calling!
  const { mkdirSync } = await import('node:fs');
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, 'secret-number.txt'), '42791\n');

  let responsesCalls = 0;
  const mockOpenAIServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          models: [{ slug: 'gpt-5-codex', display_name: 'GPT-5 Codex', visibility: 'list' }],
        })
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/responses') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      responsesCalls += 1;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      });

      const sendEv = (obj) => {
        res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`);
      };

      const hasToolResult = Array.isArray(body.input) && body.input.some((i) => i.type === 'function_call_output');

      sendEv({ type: 'response.created', response: { id: `resp_${responsesCalls}`, status: 'in_progress' } });

      if (!hasToolResult && Array.isArray(body.tools) && body.tools.some((tool) => tool.name === 'Read')) {
        // Turn 1: ask Claude Code harness to read secret-number.txt via its native Read tool!
        const filePath = join(workDir, 'secret-number.txt');
        const argsJson = JSON.stringify({ file_path: filePath });
        sendEv({
          type: 'response.output_item.added',
          output_index: 0,
          item: { id: 'fc_read_1', call_id: 'call_read_1', type: 'function_call', name: 'Read', arguments: '' },
        });
        sendEv({
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          item_id: 'fc_read_1',
          delta: argsJson,
        });
        sendEv({
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            id: 'fc_read_1',
            call_id: 'call_read_1',
            type: 'function_call',
            name: 'Read',
            arguments: argsJson,
          },
        });
        sendEv({
          type: 'response.completed',
          response: { id: `resp_${responsesCalls}`, status: 'completed', usage: { input_tokens: 50, output_tokens: 15 } },
        });
      } else {
        // Turn 2: inspect the tool_result returned by Claude Code and emit final answer!
        const toolOut = body.input.find((i) => i.type === 'function_call_output')?.output || '';
        const text = toolOut.includes('42791')
          ? 'Verified from Read tool output: 42791'
          : `Read output was: ${toolOut}`;
        sendEv({ type: 'response.output_text.delta', delta: text });
        sendEv({
          type: 'response.completed',
          response: { id: `resp_${responsesCalls}`, status: 'completed', usage: { input_tokens: 80, output_tokens: 12 } },
        });
      }
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => mockOpenAIServer.listen(0, '127.0.0.1', resolve));
  const mockPort = mockOpenAIServer.address().port;

  try {
    saveAuth({
      hostId: 'urn:uuid:e2e-test',
      openai: {
        clientId: 'oaiapp_e2e',
        accessToken: 'fake_oauth_access_token',
        refreshToken: 'fake_refresh',
        idToken: '',
        expiresAt: Date.now() + 3_600_000,
        email: 'e2e@example.com',
      },
      apiKeyFallback: '',
    });
    saveSettings({
      apiBaseUrl: `http://127.0.0.1:${mockPort}/v1`,
      defaultModel: 'gpt-5-codex',
      permissionMode: 'plan',
    });

    const run = await runClaudeHarness({
      prompt: 'Read secret-number.txt and tell me the number.',
      cwd: workDir,
      model: 'gpt-5-codex',
      permissionMode: 'plan',
      allowedTools: ['Read'],
      timeoutMs: 30_000,
    });

    assert.equal(run.status, 'completed', `Run failed: ${run.error} | stderr: ${run.stderr}`);
    assert.ok(responsesCalls >= 2, `Expected tool loop >=2 calls, got ${responsesCalls}`);
    assert.ok(run.toolsUsed.some((tool) => tool.name === 'Read'));
    assert.ok(run.resultText.includes('42791'), `Unexpected resultText: ${run.resultText}`);
  } finally {
    await new Promise((resolve) => mockOpenAIServer.close(resolve));
    delete process.env.GOAT_HARNESS_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});
