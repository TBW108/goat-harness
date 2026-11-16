import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { runGoatClaude } from '../bin/goat-claude.mjs';
import { runCli } from '../bin/goat-login.mjs';
import {
  getClaudeInstallStatus,
  installIntoClaudeCode,
  syncInstalledClaudeModel,
  uninstallFromClaudeCode,
} from '../lib/claude-installer.mjs';
import {
  buildLaunchAgentPlist,
  buildSystemdServiceUnit,
  ensureDaemonRunning,
  getDaemonStatus,
  probeProxyHealth,
  stopAndRemoveDaemon,
} from '../lib/proxy-daemon.mjs';
import { saveSettings } from '../lib/store.mjs';

function makeMemoryStream() {
  const s = new PassThrough();
  s.setEncoding('utf-8');
  return s;
}

test('buildLaunchAgentPlist escapes XML special characters and excludes unset env vars', () => {
  const plist = buildLaunchAgentPlist({
    nodeBin: '/usr/local/bin/node & stuff',
    proxyScriptPath: '/opt/goat<harness>/bin/goat-proxy.mjs',
    logPath: '/tmp/proxy"log\'.log',
    envVars: {
      HOME: '/Users/tester',
      HTTPS_PROXY: 'http://127.0.0.1:7890?a=1&b=2',
      EMPTY_VAR: '',
    },
  });
  assert.match(plist, /<string>\/usr\/local\/bin\/node &amp; stuff<\/string>/);
  assert.match(plist, /<string>\/opt\/goat&lt;harness&gt;\/bin\/goat-proxy\.mjs<\/string>/);
  assert.match(plist, /<string>\/tmp\/proxy&quot;log&apos;\.log<\/string>/);
  assert.match(plist, /<key>HTTPS_PROXY<\/key>/);
  assert.doesNotMatch(plist, /EMPTY_VAR/);

  const unit = buildSystemdServiceUnit({
    nodeBin: '/usr/bin/node',
    proxyScriptPath: '/opt/goat harness/bin/goat-proxy.mjs',
    logPath: '/home/tester/.goat-harness/proxy.log',
    envVars: {
      HOME: '/home/tester',
      HTTPS_PROXY: 'http://127.0.0.1:7890?a=100%',
      EMPTY_VAR: '',
    },
  });
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/opt\/goat harness\/bin\/goat-proxy\.mjs" serve/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /Environment="HTTPS_PROXY=http:\/\/127\.0\.0\.1:7890\?a=100%%"/);
  assert.doesNotMatch(unit, /EMPTY_VAR/);
});

test('proxy-daemon starts detached daemon on isolated ephemeral port, reports status, and stops cleanly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goat-daemon-test-'));
  const homeDir = join(root, 'home');
  const stateDir = join(root, 'state');
  mkdirSync(homeDir, { recursive: true });
  process.env.GOAT_HARNESS_HOME = stateDir;

  try {
    const started = await ensureDaemonRunning({
      homeDir,
      useLaunchd: false,
      preferredPort: 0,
    });
    assert.equal(started.ok, true);
    assert.equal(started.mode, 'detached');
    assert.ok(started.config.port > 0);
    assert.ok(started.health.pid > 0);

    const status = await getDaemonStatus({ homeDir });
    assert.equal(status.running, true);
    assert.equal(status.dynamicSettings, true);
    assert.equal(status.port, started.config.port);

    const stopRes = await stopAndRemoveDaemon({ homeDir, useLaunchd: false, removeConfig: true });
    assert.equal(stopRes.stoppedPid, true);

    await new Promise((r) => setTimeout(r, 150));
    const afterProbe = await probeProxyHealth(started.config.baseUrl, { timeoutMs: 400 });
    assert.equal(afterProbe.running, false);
  } finally {
    await stopAndRemoveDaemon({ homeDir, useLaunchd: false, removeConfig: true }).catch(() => {});
    delete process.env.GOAT_HARNESS_HOME;
    rmSync(root, { recursive: true, force: true });
  }
});

test('installIntoClaudeCode + syncInstalledClaudeModel + uninstallFromClaudeCode preserve & restore exact settings.json', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goat-install-test-'));
  const homeDir = join(root, 'home');
  const claudeDir = join(homeDir, '.claude');
  const stateDir = join(root, 'state');
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(join(claudeDir, 'skills', 'chatgpt-usage'), { recursive: true }); // Simulate pre-existing user dir that must NOT be deleted.
  writeFileSync(join(claudeDir, 'skills', 'chatgpt-usage', 'custom.txt'), 'keep me');

  const settingsPath = join(claudeDir, 'settings.json');
  const originalSettings = {
    model: 'claude-fable-5-1[1m]',
    permissions: { allow: ['Bash(git status)'] },
    enabledPlugins: { 'some-other-plugin': true },
    env: { FOO_CUSTOM: 'keep-this' },
  };
  writeFileSync(settingsPath, JSON.stringify(originalSettings, null, 2));

  process.env.GOAT_HARNESS_HOME = stateDir;
  let mcpActions = [];

  try {
    saveSettings({ defaultModel: 'gpt-6.1-sol', reasoningEffort: 'medium' });

    const installRes = await installIntoClaudeCode({
      homeDir,
      claudeDir,
      model: 'gpt-6-astra',
      effort: 'high',
      getAuthSummaryFn: () => ({ connected: true, mode: 'oauth', account: { email: 'user@example.com' } }),
      fetchModelsFn: async () => ({
        models: [
          { slug: 'gpt-6-astra', displayName: 'GPT-6 Astra', visibility: 'list', contextWindow: 272000 },
          { slug: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', visibility: 'list', contextWindow: 500000 },
          { slug: 'gpt-6.1-terra', displayName: 'GPT-6.1 Terra', visibility: 'list', contextWindow: 500000 },
          { slug: 'gpt-6-luna', displayName: 'GPT-6 Luna', visibility: 'list', contextWindow: 272000 },
        ],
      }),
      ensureDaemonFn: async () => ({
        ok: true,
        mode: 'detached',
        config: { baseUrl: 'http://127.0.0.1:47999', port: 47999, token: 'tok-install-test' },
        health: { running: true, pid: 12345 },
      }),
      resolveClaudeFn: () => '/usr/local/bin/claude',
      registerMcpFn: ({ claudeBin }) => {
        mcpActions.push(`add:${claudeBin}`);
        return { registered: true, skipped: false };
      },
      linkGlobalBinsFn: () => ({ linked: true, alreadyLinked: true }),
    });

    assert.equal(installRes.ok, true);
    assert.equal(installRes.selectedModel, 'gpt-6-astra');
    assert.equal(installRes.tiers.opus, 'gpt-6-astra');
    assert.equal(installRes.tiers.sonnet, 'gpt-6.1-sol');
    assert.equal(installRes.tiers.haiku, 'gpt-6-luna');
    assert.deepEqual(mcpActions, ['add:/usr/local/bin/claude']);

    const patched = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    assert.equal(patched.model, 'gpt-6-astra');
    assert.equal(patched.effortLevel, 'high');
    assert.equal(patched.modelPicker.replaceBuiltInOptions, true);
    assert.deepEqual(
      patched.modelPicker.options.map((o) => o.model),
      ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna']
    );
    assert.ok(patched.modelPicker.options.every((o) => o.behavesAs === 'claude-sonnet-5'));
    assert.deepEqual(patched.permissions, {
      ...originalSettings.permissions,
      defaultMode: 'acceptEdits',
    });
    assert.deepEqual(patched.enabledPlugins, originalSettings.enabledPlugins);
    assert.equal(patched.env.FOO_CUSTOM, 'keep-this');
    assert.equal(patched.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:47999');
    assert.equal(patched.env.ANTHROPIC_AUTH_TOKEN, 'tok-install-test');
    assert.equal(patched.env.ANTHROPIC_MODEL, 'gpt-6-astra');
    assert.equal(patched.env.ANTHROPIC_SMALL_FAST_MODEL, 'gpt-6-luna');
    assert.equal(patched.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'gpt-6-astra');
    assert.equal(patched.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'gpt-6.1-sol');
    assert.equal(patched.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'gpt-6-luna');
    assert.equal(patched.env.CLAUDE_CODE_AUTO_MODE_SERVER, '0');
    assert.equal(patched.env.CLAUDE_CODE_DISABLE_FAST_MODE, '1');
    assert.equal(patched.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK, '1');
    assert.equal(patched.env.CLAUDE_CODE_SUBAGENT_EFFORT, 'medium');
    assert.equal(patched.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '272000');
    assert.equal(patched.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, String(Math.floor(272000 * 0.88)));
    assert.match(patched.env.NO_PROXY, /127\.0\.0\.1/);

    // Verify symlinked skill vs skipped pre-existing user skill directory
    assert.equal(lstatSync(join(claudeDir, 'skills', 'chatgpt-login')).isSymbolicLink(), true);
    assert.equal(lstatSync(join(claudeDir, 'skills', 'chatgpt-usage')).isSymbolicLink(), false);

    // Re-install with another model must NOT overwrite original backup (`claude-fable-5-1[1m]`),
    // and set-model via goat-login CLI must sync into settings.json cleanly.
    const outSet = makeMemoryStream();
    const setCode = await runCli(['set-model', 'gpt-6.1-sol', '--effort', 'xhigh'], {
      stdout: outSet,
      stderr: makeMemoryStream(),
      syncInstalledClaudeModel: (opts) => syncInstalledClaudeModel({ ...opts, homeDir, claudeDir }),
    });
    assert.equal(setCode, 0);
    const afterSet = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    assert.equal(afterSet.model, 'gpt-6.1-sol');
    assert.equal(afterSet.effortLevel, 'xhigh');
    assert.equal(afterSet.env.ANTHROPIC_MODEL, 'gpt-6.1-sol');
    assert.equal(afterSet.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '500000');
    assert.equal(afterSet.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, String(Math.floor(500000 * 0.88)));

    const status = await getClaudeInstallStatus({
      homeDir,
      claudeDir,
      getAuthSummaryFn: () => ({ connected: true, mode: 'oauth', account: { email: 'user@example.com' } }),
      getDaemonStatusFn: async () => ({
        running: true,
        baseUrl: 'http://127.0.0.1:47999',
        pid: 12345,
      }),
    });
    assert.equal(status.installed, true);
    assert.equal(status.originalModel, 'claude-fable-5-1[1m]');
    assert.equal(status.activeClaudeModel, 'gpt-6.1-sol');

    // Also simulate user adding another env var while GOAT was installed; uninstall must keep it!
    writeFileSync(
      settingsPath,
      JSON.stringify({ ...afterSet, env: { ...afterSet.env, USER_ADDED_LATER: 'stay' } }, null, 2)
    );

    const uninstallRes = await uninstallFromClaudeCode({
      homeDir,
      claudeDir,
      stopDaemonFn: async () => ({ stoppedLaunchd: false, stoppedPid: true }),
      resolveClaudeFn: () => '/usr/local/bin/claude',
      removeMcpFn: ({ claudeBin }) => {
        mcpActions.push(`remove:${claudeBin}`);
        return { removed: true };
      },
      unlinkGlobalBinsFn: () => ({ unlinked: true }),
    });

    assert.equal(uninstallRes.ok, true);
    assert.equal(uninstallRes.hadBackup, true);
    assert.deepEqual(mcpActions, ['add:/usr/local/bin/claude', 'remove:/usr/local/bin/claude']);

    const restored = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    assert.equal(restored.model, 'claude-fable-5-1[1m]');
    assert.equal('effortLevel' in restored, false);
    assert.equal('modelPicker' in restored, false);
    assert.deepEqual(restored.permissions, originalSettings.permissions);
    assert.deepEqual(restored.enabledPlugins, originalSettings.enabledPlugins);
    assert.deepEqual(restored.env, { FOO_CUSTOM: 'keep-this', USER_ADDED_LATER: 'stay' });

    // GOAT symlink removed; pre-existing user skill directory untouched.
    assert.equal(existsSync(join(claudeDir, 'skills', 'chatgpt-login')), false);
    assert.equal(readFileSync(join(claudeDir, 'skills', 'chatgpt-usage', 'custom.txt'), 'utf-8'), 'keep me');
  } finally {
    delete process.env.GOAT_HARNESS_HOME;
    rmSync(root, { recursive: true, force: true });
  }
});

test('uninstallFromClaudeCode deletes settings.json when it did not exist prior to install and supports --purge', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goat-fresh-uninstall-'));
  const homeDir = join(root, 'home');
  const claudeDir = join(homeDir, '.claude');
  const stateDir = join(root, 'state');
  process.env.GOAT_HARNESS_HOME = stateDir;

  try {
    const outInstall = makeMemoryStream();
    const installCode = await runGoatClaude(
      ['install', '--home-dir', homeDir, '--claude-dir', claudeDir, '--model', 'gpt-6-astra', '--json'],
      {
        stdout: outInstall,
        stderr: makeMemoryStream(),
        getAuthSummary: () => ({ connected: true, mode: 'oauth', account: { email: 'fresh@example.com' } }),
        getValidOpenAIToken: async () => ({ token: 'tok', mode: 'oauth', account: {} }),
        fetchOpenAIModels: async () => ({
          models: [
            { slug: 'gpt-6-astra', displayName: 'GPT-6 Astra', visibility: 'list' },
            { slug: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', visibility: 'list' },
            { slug: 'gpt-6-luna', displayName: 'GPT-6 Luna', visibility: 'list' },
          ],
        }),
        ensureDaemonFn: async () => ({
          ok: true,
          mode: 'detached',
          config: { baseUrl: 'http://127.0.0.1:47998', port: 47998, token: 'tok-fresh' },
          health: { running: true, pid: 555 },
        }),
        resolveClaudeBinary: () => '/usr/local/bin/claude',
        registerMcpFn: () => ({ registered: true }),
      }
    );
    assert.equal(installCode, 0);
    assert.equal(existsSync(join(claudeDir, 'settings.json')), true);

    const outStatus = makeMemoryStream();
    const statusCode = await runGoatClaude(
      ['status', '--home-dir', homeDir, '--claude-dir', claudeDir],
      {
        stdout: outStatus,
        stderr: makeMemoryStream(),
        getAuthSummary: () => ({ connected: true, mode: 'oauth', account: { email: 'fresh@example.com' } }),
        getDaemonStatusFn: async () => ({ running: true, baseUrl: 'http://127.0.0.1:47998', pid: 555 }),
      }
    );
    assert.equal(statusCode, 0);
    assert.match(outStatus.read(), /Global Install\s+:\s+enabled/);

    const outUninstall = makeMemoryStream();
    const uninstallCode = await runGoatClaude(
      ['uninstall', '--home-dir', homeDir, '--claude-dir', claudeDir, '--purge'],
      {
        stdout: outUninstall,
        stderr: makeMemoryStream(),
        stopDaemonFn: async () => ({ stoppedLaunchd: false, stoppedPid: false }),
        resolveClaudeBinary: () => '/usr/local/bin/claude',
        removeMcpFn: () => ({ removed: true }),
      }
    );
    assert.equal(uninstallCode, 0);
    assert.equal(existsSync(join(claudeDir, 'settings.json')), false);
    assert.equal(existsSync(stateDir), false);
  } finally {
    delete process.env.GOAT_HARNESS_HOME;
    rmSync(root, { recursive: true, force: true });
  }
});
