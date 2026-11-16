#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { startAnthropicProxy } from '../lib/anthropic-proxy.mjs';
import {
  getClaudeInstallStatus,
  installIntoClaudeCode,
  REPO_ROOT,
  syncInstalledClaudeModel,
  uninstallFromClaudeCode,
} from '../lib/claude-installer.mjs';
import { resolveClaudeBinary } from '../lib/claude-harness.mjs';
import {
  fetchOpenAIModels,
  getAuthSummary,
  getValidOpenAIToken,
  resolveLaunchModelConfig,
  startSignInWithChatGPT,
} from '../lib/openai-oauth.mjs';
import { ensureLoopbackNoProxy } from '../lib/proxy-fetch.mjs';
import {
  formatUsageReport,
  getSettings,
  getUsageSummary,
  isMainModule,
  normalizeReasoningEffort,
  resetUsageStats,
  saveSettings,
  VALID_REASONING_EFFORTS,
} from '../lib/store.mjs';
import { runProxyMonitor } from '../lib/proxy-monitor.mjs';
import { runProxyCli } from './goat-proxy.mjs';

const CLAUDE_CLI_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

const HELP_TEXT = `Usage:
  goat-claude [goat-options] [--] [claude-args...]
  goat-claude install [--model <slug>] [--effort <level>] [--no-browser] [--no-link] [--json]
  goat-claude uninstall [--purge] [--unlink] [--json]
  goat-claude status [--json]
  goat-claude usage [--json]
  goat-claude top [--once] [--json]
  goat-claude proxy <start|stop|restart|status|monitor|serve|logs>

Launches interactive Claude Code backed by your OpenAI ChatGPT subscription
via GOAT Harness's local Anthropic-to-OpenAI proxy (no Anthropic /login needed).

Subcommands:
  install              Install Codex/ChatGPT mode globally into ~/.claude/settings.json,
                       start persistent goat-proxy daemon, and link global CLIs so bare
                       \`claude\` works in ANY directory without prompts (reversible backup)
  uninstall            Stop persistent proxy daemon and restore ~/.claude/settings.json
                       to its exact pre-install configuration (--purge removes ~/.goat-harness)
  status               Show global installation, daemon health, auth, model, and usage status
  usage                Show local token usage stats and ChatGPT quota settings link
  top | monitor        Open live terminal dashboard for active proxy requests, TTFT & cache hits
  proxy <cmd>          Manage the persistent loopback proxy daemon

GOAT options:
  --goat-login         Force a fresh Sign in with ChatGPT OAuth flow before launching
  --no-browser         Do not auto-open the browser during ChatGPT sign-in
  --goat-model <slug>  Override the OpenAI model slug for this session (e.g. gpt-6-astra)
  --set-model <slug>   Save <slug> as the persistent default OpenAI model and launch
  --effort <level>     Override OpenAI reasoning effort (${VALID_REASONING_EFFORTS.join(', ')})
  --models             List available ChatGPT models (including tiers) and exit
  --usage              Show local token usage stats and ChatGPT quota settings link, then exit
  --reset-usage        Reset local token usage stats (can combine with --usage)
  --goat-help          Show this help message

Inside Claude Code, you can also switch models live with:
  /model opus          -> gpt-6-astra (when available)
  /model sonnet        -> gpt-6.1-sol
  /model haiku         -> gpt-6-luna
  /model <slug>        -> any exact OpenAI model slug (e.g. /model gpt-6-astra)

All other flags and arguments (for example: --model, --continue, -p, --resume)
are forwarded directly to \`claude\`.
`;

export function parseLauncherArgs(argv) {
  const goat = {
    forceLogin: false,
    noBrowser: false,
    model: '',
    setDefaultModel: '',
    effort: '',
    listModels: false,
    showUsage: false,
    resetUsage: false,
    help: false,
  };
  const claudeArgs = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      claudeArgs.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '--goat-help') {
      goat.help = true;
    } else if (arg === '--goat-login') {
      goat.forceLogin = true;
    } else if (arg === '--no-browser') {
      goat.noBrowser = true;
    } else if (arg === '--models' || arg === '--list-models') {
      goat.listModels = true;
    } else if (arg === '--usage' || arg === '--goat-usage') {
      goat.showUsage = true;
    } else if (arg === '--reset-usage') {
      goat.resetUsage = true;
    } else if (arg === '--goat-model' && argv[i + 1]) {
      goat.model = String(argv[++i]).trim();
    } else if (arg.startsWith('--goat-model=')) {
      goat.model = arg.slice(13).trim();
    } else if (arg === '--set-model' && argv[i + 1]) {
      goat.setDefaultModel = String(argv[++i]).trim();
      if (!goat.model) goat.model = goat.setDefaultModel;
    } else if (arg.startsWith('--set-model=')) {
      goat.setDefaultModel = arg.slice(12).trim();
      if (!goat.model) goat.model = goat.setDefaultModel;
    } else if (arg === '--effort' && argv[i + 1]) {
      goat.effort = String(argv[++i]).trim().toLowerCase();
      if (CLAUDE_CLI_EFFORTS.has(goat.effort)) {
        claudeArgs.push('--effort', goat.effort);
      }
    } else if (arg.startsWith('--effort=')) {
      goat.effort = arg.slice(9).trim().toLowerCase();
      if (CLAUDE_CLI_EFFORTS.has(goat.effort)) {
        claudeArgs.push(arg);
      }
    } else {
      if (arg === '--model' && argv[i + 1] && !goat.model) {
        goat.model = String(argv[i + 1]).trim();
      } else if (arg.startsWith('--model=') && !goat.model) {
        goat.model = arg.slice(8).trim();
      }
      claudeArgs.push(arg);
    }
  }

  return { goat, claudeArgs };
}

function hasModelFlag(claudeArgs) {
  return claudeArgs.some((a) => a === '--model' || a.startsWith('--model='));
}

function parseSubcommandFlags(args) {
  const opts = {
    noBrowser: false,
    noLink: false,
    purge: false,
    unlink: false,
    json: false,
    force: false,
    help: false,
    model: '',
    effort: '',
    homeDir: '',
    claudeDir: '',
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h' || arg === '--goat-help') opts.help = true;
    else if (arg === '--no-browser') opts.noBrowser = true;
    else if (arg === '--no-link') opts.noLink = true;
    else if (arg === '--purge') opts.purge = true;
    else if (arg === '--unlink') opts.unlink = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--force') opts.force = true;
    else if ((arg === '--model' || arg === '--goat-model' || arg === '--set-model') && args[i + 1]) {
      opts.model = String(args[++i]).trim();
    } else if (arg.startsWith('--model=')) opts.model = arg.slice(8).trim();
    else if (arg.startsWith('--goat-model=')) opts.model = arg.slice(13).trim();
    else if (arg.startsWith('--set-model=')) opts.model = arg.slice(12).trim();
    else if (arg === '--effort' && args[i + 1]) opts.effort = String(args[++i]).trim().toLowerCase();
    else if (arg.startsWith('--effort=')) opts.effort = arg.slice(9).trim().toLowerCase();
    else if (arg === '--home-dir' && args[i + 1]) opts.homeDir = String(args[++i]).trim();
    else if (arg.startsWith('--home-dir=')) opts.homeDir = arg.slice(11).trim();
    else if (arg === '--claude-dir' && args[i + 1]) opts.claudeDir = String(args[++i]).trim();
    else if (arg.startsWith('--claude-dir=')) opts.claudeDir = arg.slice(13).trim();
  }
  return opts;
}

function defaultLinkGlobalBins() {
  const bins = ['goat-claude', 'goat-login', 'goat-proxy'];
  try {
    const allMatch = bins.every((bin) => {
      const resolved = execFileSync('which', [bin], { encoding: 'utf-8', timeout: 2000 }).trim();
      if (!resolved) return false;
      const expected = realpathSync(join(REPO_ROOT, 'bin', `${bin}.mjs`));
      return realpathSync(resolved) === expected;
    });
    if (allMatch) {
      return { linked: true, alreadyLinked: true };
    }
  } catch {
    // Not linked yet.
  }
  try {
    execFileSync('npm', ['link'], { cwd: REPO_ROOT, encoding: 'utf-8', stdio: 'pipe', timeout: 30_000 });
    return { linked: true, alreadyLinked: false };
  } catch (err) {
    return {
      linked: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function defaultUnlinkGlobalBins() {
  try {
    execFileSync('npm', ['unlink', '-g', 'goat-harness'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 15_000,
    });
    return { unlinked: true };
  } catch (err) {
    return {
      unlinked: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runGoatClaude(argv = process.argv.slice(2), deps = {}) {
  const out = deps.stdout || process.stdout;
  const errOut = deps.stderr || process.stderr;
  const getSettingsFn = deps.getSettings || getSettings;
  const saveSettingsFn = deps.saveSettings || saveSettings;
  const getUsageSummaryFn = deps.getUsageSummary || getUsageSummary;
  const resetUsageStatsFn = deps.resetUsageStats || resetUsageStats;
  const getAuthSummaryFn = deps.getAuthSummary || getAuthSummary;
  const getTokenFn = deps.getValidOpenAIToken || getValidOpenAIToken;
  const startOAuthFn = deps.startSignInWithChatGPT || startSignInWithChatGPT;
  const fetchModelsFn = deps.fetchOpenAIModels || fetchOpenAIModels;
  const resolveClaudeFn = deps.resolveClaudeBinary || resolveClaudeBinary;
  const startProxyFn = deps.startAnthropicProxy || startAnthropicProxy;
  const syncModelFn = deps.syncInstalledClaudeModel || syncInstalledClaudeModel;
  const installFn = deps.installIntoClaudeCode || installIntoClaudeCode;
  const uninstallFn = deps.uninstallFromClaudeCode || uninstallFromClaudeCode;
  const statusFn = deps.getClaudeInstallStatus || getClaudeInstallStatus;
  const runProxyCliFn = deps.runProxyCli || runProxyCli;
  const spawnFn = deps.spawn || spawn;

  const ensureConnected = async ({ forceLogin = false, noBrowser = false } = {}) => {
    const authSummary = getAuthSummaryFn();
    const needsLogin = forceLogin || !authSummary.connected;
    if (needsLogin) {
      out.write('ChatGPT subscription not signed in yet. Starting Sign in with ChatGPT...\n');
      const { authUrl, completionPromise } = await startOAuthFn({
        openBrowser: !noBrowser,
        timeoutMs: 300_000,
      });
      out.write(`Open this URL in your browser to Sign in with ChatGPT:\n  ${authUrl}\n`);
      const loginRes = await completionPromise;
      if (!loginRes?.ok) {
        errOut.write(`Sign in with ChatGPT failed: ${loginRes?.error || 'Unknown error'}\n`);
        return false;
      }
      const who = loginRes.account?.email || loginRes.account?.name || 'ChatGPT account';
      out.write(`Connected to ChatGPT as ${who}.\n`);
      return true;
    }
    await getTokenFn();
    return true;
  };

  const subcommand = String(argv[0] || '').trim();
  if (subcommand === 'proxy') {
    return runProxyCliFn(argv.slice(1), deps);
  }
  if (subcommand === 'top' || subcommand === 'monitor') {
    const rest = argv.slice(1);
    return await (deps.runProxyMonitor || runProxyMonitor)({
      once: rest.includes('--once'),
      json: rest.includes('--json'),
      stdout: out,
      stderr: errOut,
      stdin: deps.stdin || process.stdin,
    });
  }
  if (subcommand === 'usage') {
    const flags = parseSubcommandFlags(argv.slice(1));
    const usage = getUsageSummaryFn();
    if (flags.json) {
      out.write(`${JSON.stringify(usage, null, 2)}\n`);
    } else {
      out.write(formatUsageReport(usage));
    }
    return 0;
  }

  if (subcommand === 'install') {
    const flags = parseSubcommandFlags(argv.slice(1));
    if (flags.help) {
      out.write(HELP_TEXT);
      return 0;
    }
    if (flags.effort && !VALID_REASONING_EFFORTS.includes(flags.effort)) {
      errOut.write(
        `Invalid --effort "${flags.effort}". Expected one of: ${VALID_REASONING_EFFORTS.join(', ')}.\n`
      );
      return 2;
    }
    if (!(await ensureConnected({ forceLogin: flags.force, noBrowser: flags.noBrowser }))) {
      return 1;
    }
    const homeDir = flags.homeDir || deps.homeDir;
    const claudeDir = flags.claudeDir || deps.claudeDir;
    const isolatedTestDirs = Boolean(homeDir || claudeDir);
    const linkGlobalBinsFn =
      deps.linkGlobalBinsFn !== undefined
        ? deps.linkGlobalBinsFn
        : !flags.noLink && !isolatedTestDirs
          ? defaultLinkGlobalBins
          : null;

    const result = await installFn({
      ...(homeDir ? { homeDir } : {}),
      ...(claudeDir ? { claudeDir } : {}),
      model: flags.model,
      effort: flags.effort,
      fetchModelsFn,
      getAuthSummaryFn,
      resolveClaudeFn,
      linkGlobalBinsFn,
      ...(deps.ensureDaemonFn ? { ensureDaemonFn: deps.ensureDaemonFn } : {}),
      ...(deps.registerMcpFn ? { registerMcpFn: deps.registerMcpFn } : {}),
    });

    if (flags.json) {
      out.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }

    out.write(`Installed GOAT Harness Codex mode into Claude Code (${result.settingsPath}).\n`);
    out.write(`Backup saved      : ${result.backupPath}\n`);
    out.write(
      `Proxy daemon      : ${result.daemon.config.baseUrl} [${result.daemon.mode}, pid ${result.daemon.health.pid}]\n`
    );
    out.write(
      `Default model     : ${result.selectedModel} (effort: ${result.reasoningEffort})\n`
    );
    out.write(
      `Claude /model map : opus=${result.tiers.opus || '-'}, sonnet=${result.tiers.sonnet || '-'}, haiku=${result.tiers.haiku || '-'}\n`
    );
    if (result.permissionDefaultMode) {
      out.write(
        `Permission mode   : ${result.permissionDefaultMode} (Shift+Tab cycles acceptEdits / plan / auto mode)\n`
      );
    }
    if (result.globalBin?.linked) {
      out.write(
        `Global commands   : goat-claude, goat-login, goat-proxy (${result.globalBin.alreadyLinked ? 'already linked' : 'linked via npm link'})\n`
      );
    } else if (result.globalBin && !result.globalBin.skipped) {
      out.write(
        `Global commands   : link skipped/failed (${result.globalBin.error || 'run `npm link` if needed'})\n`
      );
    }
    out.write(
      `\nDone! Run \`claude\` from ANY directory to use ChatGPT models without /login.\nTo restore original Claude Code settings later: goat-claude uninstall\n`
    );
    return 0;
  }

  if (subcommand === 'uninstall') {
    const flags = parseSubcommandFlags(argv.slice(1));
    if (flags.help) {
      out.write(HELP_TEXT);
      return 0;
    }
    const homeDir = flags.homeDir || deps.homeDir;
    const claudeDir = flags.claudeDir || deps.claudeDir;
    const isolatedTestDirs = Boolean(homeDir || claudeDir);
    const unlinkGlobalBinsFn =
      deps.unlinkGlobalBinsFn !== undefined
        ? deps.unlinkGlobalBinsFn
        : flags.unlink && !isolatedTestDirs
          ? defaultUnlinkGlobalBins
          : null;

    const result = await uninstallFn({
      ...(homeDir ? { homeDir } : {}),
      ...(claudeDir ? { claudeDir } : {}),
      purge: flags.purge,
      resolveClaudeFn,
      unlinkGlobalBinsFn,
      ...(deps.stopDaemonFn ? { stopDaemonFn: deps.stopDaemonFn } : {}),
      ...(deps.removeMcpFn ? { removeMcpFn: deps.removeMcpFn } : {}),
    });

    if (flags.json) {
      out.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }

    out.write('Uninstalled GOAT Harness from Claude Code.\n');
    out.write(
      `Settings restored : ${result.settingsPath} (${result.hadBackup ? 'restored exact pre-install backup' : 'removed GOAT keys'})\n`
    );
    out.write('Proxy daemon      : stopped and removed\n');
    if (result.removedSkills?.length) {
      out.write(`Skills unlinked   : ${result.removedSkills.join(', ')}\n`);
    }
    if (result.purgedStateDir) {
      out.write('Local state dir   : purged ~/.goat-harness\n');
    }
    if (result.globalBin?.unlinked) {
      out.write('Global commands   : unlinked goat-claude, goat-login, goat-proxy\n');
    }
    return 0;
  }

  if (subcommand === 'status') {
    const flags = parseSubcommandFlags(argv.slice(1));
    const homeDir = flags.homeDir || deps.homeDir;
    const claudeDir = flags.claudeDir || deps.claudeDir;
    const status = await statusFn({
      ...(homeDir ? { homeDir } : {}),
      ...(claudeDir ? { claudeDir } : {}),
      getAuthSummaryFn,
      ...(deps.getDaemonStatusFn ? { getDaemonStatusFn: deps.getDaemonStatusFn } : {}),
    });
    const usage = getUsageSummaryFn();
    if (flags.json) {
      out.write(`${JSON.stringify({ ...status, usage }, null, 2)}\n`);
      return 0;
    }

    out.write(
      `Global Install    : ${status.installed ? `enabled (${status.settingsPath})` : 'not installed'}\n`
    );
    out.write(
      `ChatGPT Auth      : ${status.auth.connected ? `connected (${status.auth.account?.email || status.auth.mode})` : 'not signed in'}\n`
    );
    out.write(
      `Proxy Daemon      : ${status.daemon.running ? `running (${status.daemon.baseUrl}, pid ${status.daemon.pid})` : 'stopped'}\n`
    );
    out.write(
      `Active Model      : ${status.activeClaudeModel || status.defaultModel || '-'} (effort: ${status.reasoningEffort})\n`
    );
    if (status.permissionDefaultMode) {
      out.write(`Permission Mode   : ${status.permissionDefaultMode}\n`);
    }
    if (status.originalModel) {
      out.write(`Backed-up Model   : ${status.originalModel} (restored on uninstall)\n`);
    }
    out.write(
      `Global CLI        : ${status.globalGoatClaude || 'not in PATH (run `npm link` or `goat-claude install`)'}\n`
    );
    out.write(`Skills Linked     : ${status.skills.map((s) => `${s.name}:${s.installed ? 'yes' : 'no'}`).join(', ')}\n`);
    out.write('\n');
    out.write(formatUsageReport(usage));
    return 0;
  }

  const { goat, claudeArgs } = parseLauncherArgs(argv);
  if (goat.help) {
    out.write(HELP_TEXT);
    return 0;
  }

  if (goat.resetUsage) {
    await resetUsageStatsFn();
    out.write('Local usage ledger reset.\n');
    if (!goat.showUsage && !goat.listModels && !goat.setDefaultModel) {
      // Wait — if user ran `goat-claude --reset-usage`, exit cleanly instead of booting Claude unless they passed Claude args.
      if (!claudeArgs.length && !goat.model) return 0;
    }
  }

  if (goat.showUsage) {
    out.write(formatUsageReport(getUsageSummaryFn()));
    return 0;
  }

  let settings = getSettingsFn();
  if (goat.effort && !VALID_REASONING_EFFORTS.includes(goat.effort)) {
    errOut.write(
      `Invalid --effort "${goat.effort}". Expected one of: ${VALID_REASONING_EFFORTS.join(', ')}.\n`
    );
    return 2;
  }

  if (goat.setDefaultModel) {
    const patch = { defaultModel: goat.setDefaultModel };
    if (goat.effort) patch.reasoningEffort = goat.effort;
    settings = saveSettingsFn(patch);
    try {
      syncModelFn({ model: settings.defaultModel, effort: settings.reasoningEffort });
    } catch {
      // Non-fatal if Claude Code settings cannot be synced.
    }
    out.write(`Saved default model: ${settings.defaultModel} (effort: ${settings.reasoningEffort}).\n`);
  }

  if (goat.listModels) {
    if (!(await ensureConnected({ forceLogin: goat.forceLogin, noBrowser: goat.noBrowser }))) {
      return 1;
    }
    const config = await resolveLaunchModelConfig({
      requestedModel: goat.model,
      defaultModel: settings.defaultModel,
      getModelsFn: fetchModelsFn,
    });
    if (!config.models.length) {
      out.write('No models returned.\n');
      return 0;
    }
    for (const m of config.models) {
      const mark = config.selectedModel === m.slug ? '*' : ' ';
      const label = m.displayName !== m.slug ? ` (${m.displayName})` : '';
      const levels = m.supportedReasoningLevels?.length
        ? ` | efforts: ${m.supportedReasoningLevels.join('/')}`
        : '';
      out.write(`${mark} ${m.slug}${label}${levels}\n`);
    }
    out.write(
      `\nClaude /model tiers: opus=${config.tiers.opus || '-'}, sonnet=${config.tiers.sonnet || '-'}, haiku=${config.tiers.haiku || '-'}\n`
    );
    return 0;
  }

  const claudeBin = resolveClaudeFn(settings.claudePath);
  if (!claudeBin) {
    errOut.write('Claude Code CLI (`claude`) not found. Install `@anthropic-ai/claude-code` or set claudePath.\n');
    return 1;
  }

  if (!(await ensureConnected({ forceLogin: goat.forceLogin, noBrowser: goat.noBrowser }))) {
    return 1;
  }

  const launchConfig = await resolveLaunchModelConfig({
    requestedModel: goat.model,
    defaultModel: settings.defaultModel,
    getModelsFn: fetchModelsFn,
  });
  const selectedModel = launchConfig.selectedModel;
  const tiers = launchConfig.tiers;
  if (!selectedModel) {
    errOut.write('No OpenAI model available from your ChatGPT subscription. Pass --goat-model <slug>.\n');
    return 1;
  }

  const reasoningEffort = normalizeReasoningEffort(goat.effort || settings.reasoningEffort || 'medium');

  const proxy = await startProxyFn({
    defaultModel: selectedModel,
    modelTiers: tiers,
    models: launchConfig.models,
    reasoningEffort,
    source: 'claude-cli',
    getTokenFn,
    getModelsFn: fetchModelsFn,
  });

  const contextWindow = Number(launchConfig.contextWindow || 0);
  const autoCompactWindow = contextWindow >= 64_000 ? Math.floor(contextWindow * 0.88) : 0;
  const childEnv = ensureLoopbackNoProxy({
    ...(deps.baseEnv || process.env),
    ANTHROPIC_BASE_URL: proxy.baseUrl,
    ANTHROPIC_AUTH_TOKEN: proxy.token,
    ANTHROPIC_MODEL: selectedModel,
    ANTHROPIC_SMALL_FAST_MODEL: tiers.haiku || selectedModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: tiers.opus || selectedModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: tiers.sonnet || selectedModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: tiers.haiku || selectedModel,
    CLAUDE_CODE_AUTO_MODE_SERVER: '0',
    CLAUDE_CODE_DISABLE_FAST_MODE: '1',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
    CLAUDE_CODE_SUBAGENT_EFFORT: 'medium',
    ...(contextWindow > 0 ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextWindow) } : {}),
    ...(autoCompactWindow > 0 ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(autoCompactWindow) } : {}),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
  // Setting ANTHROPIC_API_KEY triggers an interactive confirmation prompt in Claude Code;
  // ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL boots straight in without /login prompts.
  delete childEnv.ANTHROPIC_API_KEY;

  const finalArgs = hasModelFlag(claudeArgs) ? claudeArgs : ['--model', selectedModel, ...claudeArgs];
  out.write(`Launching Claude Code via GOAT Harness (${selectedModel}, effort: ${reasoningEffort})...\n`);
  if (launchConfig.models.length > 1) {
    const altSlug = launchConfig.models.find((m) => m.slug !== selectedModel)?.slug || 'gpt-6-astra';
    out.write(
      `Models: opus->${tiers.opus}, sonnet->${tiers.sonnet}, haiku->${tiers.haiku} | Switch: /model opus, /model ${altSlug}, or --goat-model ${altSlug}\n`
    );
  }

  try {
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawnFn(claudeBin, finalArgs, {
        cwd: deps.cwd || process.cwd(),
        env: childEnv,
        stdio: 'inherit',
      });

      const forwardSignal = (sig) => {
        try {
          child.kill(sig);
        } catch {
          // Ignore forwarding failures.
        }
      };
      const onSigInt = () => forwardSignal('SIGINT');
      const onSigTerm = () => forwardSignal('SIGTERM');
      process.on('SIGINT', onSigInt);
      process.on('SIGTERM', onSigTerm);

      const cleanupListeners = () => {
        process.off('SIGINT', onSigInt);
        process.off('SIGTERM', onSigTerm);
      };

      child.on('error', (err) => {
        cleanupListeners();
        reject(err);
      });
      child.on('close', (code, signal) => {
        cleanupListeners();
        if (typeof code === 'number') resolve(code);
        else resolve(signal ? 1 : 0);
      });
    });
    return exitCode;
  } finally {
    await proxy.close();
  }
}

if (isMainModule(import.meta.url)) {
  runGoatClaude()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      const causeMsg = err?.cause instanceof Error ? err.cause.message : err?.cause ? String(err.cause) : '';
      process.stderr.write(`${msg}${causeMsg ? ` (${causeMsg})` : ''}\n`);
      process.exitCode = 1;
    });
}
