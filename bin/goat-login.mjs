#!/usr/bin/env node
import { checkClaudeHealth } from '../lib/claude-harness.mjs';
import {
  fetchOpenAIModels,
  getAuthSummary,
  selectModelTiers,
  signOutChatGPT,
  startSignInWithChatGPT,
} from '../lib/openai-oauth.mjs';
import {
  formatTokenCount,
  formatUsageReport,
  getSettings,
  getUsageSummary,
  isMainModule,
  resetUsageStats,
  saveSettings,
  VALID_REASONING_EFFORTS,
} from '../lib/store.mjs';
import { syncInstalledClaudeModel } from '../lib/claude-installer.mjs';

const USAGE = `Usage: goat-login <command> [options]

Commands:
  login [--no-browser] [--force] [--timeout <sec>] [--json]
      Sign in with your ChatGPT subscription via OAuth 2.0 + PKCE.
  status [--json]
      Show ChatGPT connection, Claude CLI status, saved settings, and usage summary.
  models [--refresh] [--json]
      List OpenAI models available to your signed-in ChatGPT account.
  set-model <slug> [--effort <${VALID_REASONING_EFFORTS.join('|')}>] [--json]
      Save the default OpenAI model (and optional reasoning effort).
  usage [--reset] [--json]
      Show local OpenAI token usage (by window & model) and ChatGPT quota settings link.
  logout [--json]
      Clear stored ChatGPT OAuth credentials.
`;

export function parseCliArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'login';
  const flags = {
    json: false,
    noBrowser: false,
    force: false,
    refresh: false,
    reset: false,
    timeoutSec: 180,
    effort: '',
    help: false,
  };
  const positionals = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--help' || token === '-h') {
      flags.help = true;
    } else if (token === '--json') {
      flags.json = true;
    } else if (token === '--no-browser') {
      flags.noBrowser = true;
    } else if (token === '--force') {
      flags.force = true;
    } else if (token === '--refresh') {
      flags.refresh = true;
    } else if (token === '--reset') {
      flags.reset = true;
    } else if (token === '--timeout' && args[i + 1]) {
      flags.timeoutSec = Math.min(600, Math.max(5, Number(args[++i]) || 180));
    } else if (token.startsWith('--timeout=')) {
      flags.timeoutSec = Math.min(600, Math.max(5, Number(token.slice(10)) || 180));
    } else if (token === '--effort' && args[i + 1]) {
      flags.effort = String(args[++i]).trim().toLowerCase();
    } else if (token.startsWith('--effort=')) {
      flags.effort = token.slice(9).trim().toLowerCase();
    } else if (!token.startsWith('-')) {
      positionals.push(token);
    } else {
      throw new Error(`Unknown option: ${token}`);
    }
  }

  return { command, flags, positionals };
}

export async function runCli(argv = process.argv.slice(2), deps = {}) {
  const out = deps.stdout || process.stdout;
  const errOut = deps.stderr || process.stderr;
  const authSummaryFn = deps.getAuthSummary || getAuthSummary;
  const startOAuthFn = deps.startSignInWithChatGPT || startSignInWithChatGPT;
  const fetchModelsFn = deps.fetchOpenAIModels || fetchOpenAIModels;
  const signOutFn = deps.signOutChatGPT || signOutChatGPT;
  const getSettingsFn = deps.getSettings || getSettings;
  const saveSettingsFn = deps.saveSettings || saveSettings;
  const getUsageSummaryFn = deps.getUsageSummary || getUsageSummary;
  const resetUsageStatsFn = deps.resetUsageStats || resetUsageStats;
  const claudeHealthFn = deps.checkClaudeHealth || checkClaudeHealth;

  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    errOut.write(`${err.message}\n${USAGE}`);
    return 2;
  }

  const { command, flags, positionals } = parsed;
  if (flags.help || command === 'help') {
    out.write(USAGE);
    return 0;
  }

  const writePayload = (obj) => {
    out.write(`${JSON.stringify(obj, null, 2)}\n`);
  };

  if (command === 'status') {
    const settings = getSettingsFn();
    const auth = authSummaryFn();
    const claude = claudeHealthFn(settings.claudePath);
    const usage = getUsageSummaryFn();
    if (flags.json) {
      writePayload({ auth, claude, settings, usage });
    } else {
      const who = auth.account?.email || auth.account?.name || 'Not signed in';
      const plan = auth.account?.planType ? ` (${auth.account.planType})` : '';
      out.write(`ChatGPT Auth : ${auth.connected ? `connected [${auth.mode}] — ${who}${plan}` : 'not signed in'}\n`);
      out.write(`Default Model: ${settings.defaultModel || '(auto)'}\n`);
      out.write(`Reasoning    : ${settings.reasoningEffort}\n`);
      out.write(`Claude CLI   : ${claude.available ? `${claude.version} (${claude.path})` : claude.error}\n`);
      out.write(
        `Usage (today): ${usage.today.requests} reqs | ${formatTokenCount(usage.today.totalTokens)} tokens (all-time: ${formatTokenCount(
          usage.allTime.totalTokens
        )})\n`
      );
      out.write(`Quota Web UI : ${usage.chatgptUsageSettingsUrl}\n`);
    }
    return 0;
  }

  if (command === 'usage') {
    if (flags.reset) {
      await resetUsageStatsFn();
    }
    const usage = getUsageSummaryFn();
    if (flags.json) {
      writePayload({ reset: flags.reset, usage });
    } else {
      if (flags.reset) {
        out.write('Local usage ledger reset.\n');
      }
      out.write(formatUsageReport(usage));
    }
    return 0;
  }

  if (command === 'logout') {
    signOutFn();
    if (flags.json) {
      writePayload({ status: 'signed_out', auth: authSummaryFn() });
    } else {
      out.write('Signed out of ChatGPT subscription.\n');
    }
    return 0;
  }

  if (command === 'models') {
    const catalog = await fetchModelsFn({ forceRefresh: flags.refresh });
    const settings = getSettingsFn();
    const defaultModel = settings.defaultModel || catalog.models[0]?.slug || '';
    const tiers = selectModelTiers(catalog.models, defaultModel);
    if (flags.json) {
      writePayload({
        authMode: catalog.mode,
        accountEmail: catalog.account?.email || '',
        defaultModel,
        tiers,
        models: catalog.models,
      });
    } else {
      if (!catalog.models.length) {
        out.write('No models returned.\n');
      } else {
        for (const m of catalog.models) {
          const mark = defaultModel === m.slug ? '*' : ' ';
          const label = m.displayName !== m.slug ? ` (${m.displayName})` : '';
          const ctx = m.contextWindow ? ` | ctx ${formatTokenCount(m.contextWindow)}` : '';
          const levels = m.supportedReasoningLevels?.length
            ? ` | efforts: ${m.supportedReasoningLevels.join('/')}`
            : '';
          out.write(`${mark} ${m.slug}${label}${ctx}${levels}\n`);
          if (m.description) {
            out.write(`    ${m.description}\n`);
          }
        }
        out.write(
          `\nClaude /model tiers: opus=${tiers.opus || '-'}, sonnet=${tiers.sonnet || '-'}, haiku=${tiers.haiku || '-'}\n`
        );
        out.write(`Switch persistent default: goat-login set-model <slug> [--effort ${VALID_REASONING_EFFORTS.join('|')}]\n`);
      }
    }
    return 0;
  }

  if (command === 'set-model') {
    const model = positionals[0]?.trim() || '';
    if (!model) {
      errOut.write(
        `Missing model slug. Usage: goat-login set-model <slug> [--effort ${VALID_REASONING_EFFORTS.join('|')}]\n`
      );
      return 2;
    }
    const patch = { defaultModel: model };
    if (flags.effort) {
      if (!VALID_REASONING_EFFORTS.includes(flags.effort)) {
        errOut.write(
          `Invalid --effort value "${flags.effort}". Expected one of: ${VALID_REASONING_EFFORTS.join(', ')}.\n`
        );
        return 2;
      }
      patch.reasoningEffort = flags.effort;
    }
    const updated = saveSettingsFn(patch);
    const syncModelFn = deps.syncInstalledClaudeModel || syncInstalledClaudeModel;
    try {
      syncModelFn({ model: updated.defaultModel, effort: updated.reasoningEffort });
    } catch {
      // Non-fatal if Claude Code settings cannot be synced.
    }
    if (flags.json) {
      writePayload({ ok: true, settings: updated });
    } else {
      out.write(`Default model set to ${updated.defaultModel} (effort: ${updated.reasoningEffort}).\n`);
    }
    return 0;
  }

  if (command === 'login') {
    const current = authSummaryFn();
    if (current.mode === 'oauth' && !flags.force) {
      const who = current.account?.email || current.account?.name || 'ChatGPT account';
      if (flags.json) {
        writePayload({ status: 'already_connected', auth: current });
      } else {
        out.write(`Already signed in to ChatGPT as ${who}. Pass --force to sign in again.\n`);
      }
      return 0;
    }

    const openBrowser = !flags.noBrowser;
    const { authUrl, redirectUri, completionPromise } = await startOAuthFn({
      openBrowser,
      timeoutMs: flags.timeoutSec * 1000,
    });

    if (flags.json) {
      out.write(`${JSON.stringify({ event: 'pending', auth_url: authUrl, redirect_uri: redirectUri })}\n`);
    } else {
      out.write(`Open this URL to Sign in with ChatGPT:\n  ${authUrl}\n`);
      out.write(`Waiting up to ${flags.timeoutSec}s for browser callback...\n`);
    }

    const result = await completionPromise;
    if (!result?.ok) {
      const msg = result?.error || 'ChatGPT sign-in failed.';
      if (flags.json) {
        writePayload({ status: 'error', error: msg });
      } else {
        errOut.write(`Sign-in failed: ${msg}\n`);
      }
      return 1;
    }

    let models = [];
    let modelsError = '';
    try {
      const catalog = await fetchModelsFn({ forceRefresh: true });
      models = catalog.models || [];
    } catch (err) {
      modelsError = err instanceof Error ? err.message : String(err);
    }

    const settings = getSettingsFn();
    const auth = authSummaryFn();
    if (flags.json) {
      writePayload({
        status: 'connected',
        auth,
        account: result.account || auth.account,
        defaultModel: settings.defaultModel || models[0]?.slug || '',
        models,
        ...(modelsError ? { modelsError } : {}),
      });
    } else {
      const who = result.account?.email || result.account?.name || 'ChatGPT account';
      const plan = result.account?.planType ? ` (${result.account.planType})` : '';
      out.write(`Connected to ChatGPT as ${who}${plan}.\n`);
      if (models.length) {
        out.write(`Available models (${models.length}): ${models.slice(0, 6).map((m) => m.slug).join(', ')}\n`);
      } else if (modelsError) {
        out.write(`Signed in, but could not fetch model list: ${modelsError}\n`);
      }
    }
    return 0;
  }

  errOut.write(`Unknown command: ${command}\n${USAGE}`);
  return 2;
}

if (isMainModule(import.meta.url)) {
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
