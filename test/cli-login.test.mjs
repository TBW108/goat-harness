import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { parseLauncherArgs, runGoatClaude } from '../bin/goat-claude.mjs';
import { parseCliArgs, runCli } from '../bin/goat-login.mjs';
import { getSettings, recordUsageEvent } from '../lib/store.mjs';

function makeMemoryStream() {
  let buf = '';
  return {
    write(chunk) {
      buf += String(chunk);
    },
    read() {
      return buf;
    },
  };
}

test('parseCliArgs parses commands and options', () => {
  const def = parseCliArgs([]);
  assert.equal(def.command, 'login');
  assert.equal(def.flags.noBrowser, false);

  const login = parseCliArgs(['login', '--no-browser', '--force', '--timeout', '60', '--json']);
  assert.equal(login.command, 'login');
  assert.equal(login.flags.noBrowser, true);
  assert.equal(login.flags.force, true);
  assert.equal(login.flags.timeoutSec, 60);
  assert.equal(login.flags.json, true);

  const setModel = parseCliArgs(['set-model', 'gpt-5.3-codex', '--effort=high']);
  assert.equal(setModel.command, 'set-model');
  assert.deepEqual(setModel.positionals, ['gpt-5.3-codex']);
  assert.equal(setModel.flags.effort, 'high');
});

test('runCli handles login, status, models, set-model, and logout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goat-cli-login-test-'));
  process.env.GOAT_HARNESS_HOME = dir;

  try {
    let connected = false;
    const baseDeps = () => ({
      getAuthSummary: () =>
        connected
          ? { connected: true, mode: 'oauth', account: { email: 'cli@example.com', planType: 'plus' } }
          : { connected: false, mode: 'none', account: null },
      checkClaudeHealth: () => ({ available: true, path: '/opt/homebrew/bin/claude', version: '2.1.322' }),
      startSignInWithChatGPT: async ({ openBrowser }) => {
        assert.equal(openBrowser, false);
        return {
          authUrl: 'https://auth.openai.com/authorize?state=cli1',
          redirectUri: 'http://127.0.0.1:45555/auth/callback',
          completionPromise: Promise.resolve().then(() => {
            connected = true;
            return { ok: true, account: { email: 'cli@example.com', planType: 'plus' } };
          }),
        };
      },
      fetchOpenAIModels: async () => ({
        mode: 'oauth',
        account: { email: 'cli@example.com' },
        models: [{ slug: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', visibility: 'list' }],
      }),
      signOutChatGPT: () => {
        connected = false;
      },
    });

    const outLogin = makeMemoryStream();
    const errLogin = makeMemoryStream();
    const codeLogin = await runCli(['login', '--no-browser', '--json'], {
      ...baseDeps(),
      stdout: outLogin,
      stderr: errLogin,
    });
    assert.equal(codeLogin, 0);
    const lines = outLogin.read().trim().split('\n');
    const firstEvent = JSON.parse(lines[0]);
    assert.equal(firstEvent.event, 'pending');
    assert.equal(firstEvent.auth_url, 'https://auth.openai.com/authorize?state=cli1');
    const finalPayload = JSON.parse(lines.slice(1).join('\n'));
    assert.equal(finalPayload.status, 'connected');
    assert.equal(finalPayload.account.email, 'cli@example.com');

    const outSet = makeMemoryStream();
    const codeSet = await runCli(['set-model', 'gpt-5.3-codex', '--effort', 'high', '--json'], {
      ...baseDeps(),
      stdout: outSet,
      stderr: makeMemoryStream(),
    });
    assert.equal(codeSet, 0);
    assert.equal(getSettings().defaultModel, 'gpt-5.3-codex');
    assert.equal(getSettings().reasoningEffort, 'high');

    const outStatus = makeMemoryStream();
    const codeStatus = await runCli(['status', '--json'], {
      ...baseDeps(),
      stdout: outStatus,
      stderr: makeMemoryStream(),
    });
    assert.equal(codeStatus, 0);
    assert.equal(JSON.parse(outStatus.read()).auth.connected, true);

    const outLogout = makeMemoryStream();
    const codeLogout = await runCli(['logout', '--json'], {
      ...baseDeps(),
      stdout: outLogout,
      stderr: makeMemoryStream(),
    });
    assert.equal(codeLogout, 0);
    assert.equal(JSON.parse(outLogout.read()).status, 'signed_out');
    assert.equal(connected, false);
  } finally {
    delete process.env.GOAT_HARNESS_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseLauncherArgs separates GOAT flags from forwarded claude args', () => {
  const parsed = parseLauncherArgs([
    '--goat-login',
    '--no-browser',
    '--goat-model',
    'gpt-5.4',
    '--effort=high',
    '--continue',
    '--resume',
    'sess_1',
  ]);
  assert.equal(parsed.goat.forceLogin, true);
  assert.equal(parsed.goat.noBrowser, true);
  assert.equal(parsed.goat.model, 'gpt-5.4');
  assert.equal(parsed.goat.effort, 'high');
  assert.deepEqual(parsed.claudeArgs, ['--effort=high', '--continue', '--resume', 'sess_1']);
});

test('runGoatClaude triggers ChatGPT login if disconnected, strips ANTHROPIC_API_KEY, and closes proxy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goat-claude-launcher-test-'));
  process.env.GOAT_HARNESS_HOME = dir;

  try {
    let oauthStarted = false;
    let proxyClosed = false;
    let spawned = null;

    const out = makeMemoryStream();
    const err = makeMemoryStream();

    const code = await runGoatClaude(['--continue'], {
      stdout: out,
      stderr: err,
      baseEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'stale_key_should_be_removed' },
      getSettings: () => ({
        claudePath: '/opt/homebrew/bin/claude',
        defaultModel: '',
        reasoningEffort: 'medium',
      }),
      resolveClaudeBinary: () => '/opt/homebrew/bin/claude',
      getAuthSummary: () => ({ connected: false, mode: 'none', account: null }),
      startSignInWithChatGPT: async ({ openBrowser }) => {
        oauthStarted = true;
        assert.equal(openBrowser, true);
        return {
          authUrl: 'https://auth.openai.com/authorize?state=launch1',
          redirectUri: 'http://127.0.0.1:46666/auth/callback',
          completionPromise: Promise.resolve({
            ok: true,
            account: { email: 'launcher@example.com', planType: 'pro' },
          }),
        };
      },
      getValidOpenAIToken: async () => ({ token: 'tok_live', mode: 'oauth', account: {} }),
      fetchOpenAIModels: async () => ({
        mode: 'oauth',
        account: { email: 'launcher@example.com' },
        models: [{ slug: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', visibility: 'list' }],
      }),
      startAnthropicProxy: async ({ defaultModel, reasoningEffort }) => {
        assert.equal(defaultModel, 'gpt-5.3-codex');
        assert.equal(reasoningEffort, 'medium');
        return {
          baseUrl: 'http://127.0.0.1:47777',
          token: 'proxy_tok_123',
          close: async () => {
            proxyClosed = true;
          },
        };
      },
      spawn: (bin, args, opts) => {
        spawned = { bin, args, opts };
        const child = new EventEmitter();
        child.kill = () => {};
        queueMicrotask(() => child.emit('close', 0, null));
        return child;
      },
    });

    assert.equal(code, 0);
    assert.equal(oauthStarted, true);
    assert.equal(proxyClosed, true);
    assert.equal(spawned.bin, '/opt/homebrew/bin/claude');
    assert.deepEqual(spawned.args, ['--model', 'gpt-5.3-codex', '--continue']);
    assert.equal(spawned.opts.stdio, 'inherit');
    assert.equal(spawned.opts.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:47777');
    assert.equal(spawned.opts.env.ANTHROPIC_AUTH_TOKEN, 'proxy_tok_123');
    assert.equal('ANTHROPIC_API_KEY' in spawned.opts.env, false);
    assert.equal(spawned.opts.env.ANTHROPIC_MODEL, 'gpt-5.3-codex');
    assert.match(out.read(), /auth\.openai\.com\/authorize/);
  } finally {
    delete process.env.GOAT_HARNESS_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI supports usage reporting, gpt-6-astra tiers, xhigh/ultra effort, and goat-claude --models/--usage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goat-cli-astra-usage-'));
  process.env.GOAT_HARNESS_HOME = dir;

  try {
    await recordUsageEvent({
      model: 'gpt-6-astra',
      inputTokens: 1200,
      cachedTokens: 400,
      outputTokens: 300,
      reasoningTokens: 150,
    });

    const outUsage = makeMemoryStream();
    const usageCode = await runCli(['usage', '--json'], {
      stdout: outUsage,
      stderr: makeMemoryStream(),
    });
    assert.equal(usageCode, 0);
    const usageJson = JSON.parse(outUsage.read());
    assert.equal(usageJson.usage.allTime.totalTokens, 1500);
    assert.equal(usageJson.usage.byModel['gpt-6-astra'].reasoningTokens, 150);

    const outReset = makeMemoryStream();
    const resetCode = await runCli(['usage', '--reset', '--json'], {
      stdout: outReset,
      stderr: makeMemoryStream(),
    });
    assert.equal(resetCode, 0);
    assert.equal(JSON.parse(outReset.read()).usage.allTime.requests, 0);

    const outSet = makeMemoryStream();
    const setCode = await runCli(['set-model', 'gpt-6-astra', '--effort', 'xhigh', '--json'], {
      stdout: outSet,
      stderr: makeMemoryStream(),
    });
    assert.equal(setCode, 0);
    assert.equal(getSettings().defaultModel, 'gpt-6-astra');
    assert.equal(getSettings().reasoningEffort, 'xhigh');

    // `ultra` is accepted for OpenAI Responses proxy while withheld from Claude CLI's --effort flag
    const parsedUltra = parseLauncherArgs(['--goat-model', 'gpt-6-astra', '--effort', 'ultra', '-p', 'hi']);
    assert.equal(parsedUltra.goat.effort, 'ultra');
    assert.deepEqual(parsedUltra.claudeArgs, ['-p', 'hi']);

    const outModels = makeMemoryStream();
    const modelsCode = await runGoatClaude(['--models'], {
      stdout: outModels,
      stderr: makeMemoryStream(),
      getSettings: () => ({ claudePath: '/opt/homebrew/bin/claude', defaultModel: '', reasoningEffort: 'medium' }),
      getAuthSummary: () => ({ connected: true, mode: 'oauth', account: { email: 'a@b.com' } }),
      getValidOpenAIToken: async () => ({ token: 'tok', mode: 'oauth', account: {} }),
      fetchOpenAIModels: async () => ({
        mode: 'oauth',
        account: { email: 'a@b.com' },
        models: [
          { slug: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', visibility: 'list', supportedReasoningLevels: ['low', 'xhigh', 'ultra'] },
          { slug: 'gpt-6-astra', displayName: 'GPT-6 Astra', visibility: 'list', supportedReasoningLevels: ['low', 'xhigh', 'ultra'] },
          { slug: 'gpt-6-luna', displayName: 'GPT-6 Luna', visibility: 'list' },
        ],
      }),
    });
    assert.equal(modelsCode, 0);
    assert.match(outModels.read(), /gpt-6-astra/);
    assert.match(outModels.read(), /opus=gpt-6-astra, sonnet=gpt-6\.1-sol, haiku=gpt-6-luna/);

    let launchEnv = null;
    const launchCode = await runGoatClaude(['--effort', 'xhigh'], {
      stdout: makeMemoryStream(),
      stderr: makeMemoryStream(),
      getSettings: () => ({ claudePath: '/opt/homebrew/bin/claude', defaultModel: 'gpt-6-astra', reasoningEffort: 'medium' }),
      resolveClaudeBinary: () => '/opt/homebrew/bin/claude',
      getAuthSummary: () => ({ connected: true, mode: 'oauth', account: { email: 'a@b.com' } }),
      getValidOpenAIToken: async () => ({ token: 'tok', mode: 'oauth', account: {} }),
      fetchOpenAIModels: async () => ({
        mode: 'oauth',
        account: { email: 'a@b.com' },
        models: [
          { slug: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', visibility: 'list' },
          { slug: 'gpt-6-astra', displayName: 'GPT-6 Astra', visibility: 'list' },
          { slug: 'gpt-6-luna', displayName: 'GPT-6 Luna', visibility: 'list' },
        ],
      }),
      startAnthropicProxy: async ({ modelTiers, reasoningEffort }) => {
        assert.equal(modelTiers.opus, 'gpt-6-astra');
        assert.equal(modelTiers.haiku, 'gpt-6-luna');
        assert.equal(reasoningEffort, 'xhigh');
        return { baseUrl: 'http://127.0.0.1:48888', token: 'ptok', close: async () => {} };
      },
      spawn: (bin, args, opts) => {
        launchEnv = opts.env;
        const child = new EventEmitter();
        child.kill = () => {};
        queueMicrotask(() => child.emit('close', 0, null));
        return child;
      },
    });
    assert.equal(launchCode, 0);
    assert.equal(launchEnv.ANTHROPIC_MODEL, 'gpt-6-astra');
    assert.equal(launchEnv.ANTHROPIC_DEFAULT_OPUS_MODEL, 'gpt-6-astra');
    assert.equal(launchEnv.ANTHROPIC_DEFAULT_SONNET_MODEL, 'gpt-6.1-sol');
    assert.equal(launchEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'gpt-6-luna');
  } finally {
    delete process.env.GOAT_HARNESS_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});
