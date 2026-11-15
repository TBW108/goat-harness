import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkClaudeHealth } from './claude-harness.mjs';
import { getAuthSummary } from './openai-oauth.mjs';
import { getHookState, getSettings, saveHookState } from './store.mjs';

const EDIT_TOOLS = new Set([
  'edit_file',
  'write_file',
  'replace_file_content',
  'multi_replace_file_content',
  'create_file',
  'delete_file',
]);

const CODE_EXT_RE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|swift|rb|php|sh|json|ya?ml)$/i;

const VERIFY_CMD_RE =
  /(?:^|\s|&&|\|\||;)(?:npm\s+(?:test|run\s+(?:test|lint|typecheck|check|build))|pnpm\s+(?:test|lint|typecheck|check|build)|yarn\s+(?:test|lint|typecheck|check|build)|node\s+--test\b|vitest\b|jest\b|pytest\b|python3?\s+-m\s+(?:pytest|unittest)\b|cargo\s+(?:test|check|clippy)\b|go\s+test\b|tsc\b|eslint\b|ruff\b|mypy\b)/i;

const HARD_DENY_PATTERNS = [
  {
    re: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+(?:\/(?:\s|$|\*)|~(?:\/|\s|$)|\$HOME(?:\/|\s|$)|"\$HOME")/,
    reason: 'Blocked catastrophic recursive delete targeting root or home directory.',
  },
  {
    re: /\b(?:mkfs(?:\.[a-z0-9]+)?|fdisk|diskutil\s+eraseDisk)\b/i,
    reason: 'Blocked destructive disk formatting command.',
  },
  {
    re: /\bdd\b[^\n]*\bof=\/dev\/(?:disk|sd|nvme|hd)/i,
    reason: 'Blocked raw block device overwrite command.',
  },
];

const ASK_CONFIRM_PATTERNS = [
  {
    re: /\bgit\s+push\b[^\n]*(?:--force|-f\b)(?!-with-lease)/,
    reason: 'Force-pushing without --force-with-lease can overwrite remote history; confirm explicitly.',
  },
  {
    re: /\bgit\s+reset\s+--hard\b/,
    reason: 'git reset --hard discards uncommitted working-tree changes; confirm explicitly.',
  },
  {
    re: /\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/,
    reason: 'Piping remote scripts directly to a shell requires explicit review.',
  },
];

export function hasProjectVerifySuite(workspacePaths = []) {
  for (const ws of workspacePaths) {
    if (!ws || !existsSync(ws)) continue;
    const pkgPath = join(ws, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        const testScript = String(pkg?.scripts?.test || '');
        if (testScript && !testScript.includes('no test specified')) {
          return true;
        }
        if (pkg?.scripts?.lint || pkg?.scripts?.typecheck || pkg?.scripts?.check) {
          return true;
        }
      } catch {
        // Ignore invalid package.json.
      }
    }
    for (const marker of ['pyproject.toml', 'pytest.ini', 'Cargo.toml', 'go.mod']) {
      if (existsSync(join(ws, marker))) return true;
    }
  }
  return false;
}

export function evaluateSessionStart() {
  const auth = getAuthSummary();
  const settings = getSettings();
  const claude = checkClaudeHealth(settings.claudePath);
  const authText = auth.connected
    ? `ChatGPT subscription connected (${auth.account?.email || auth.mode}).`
    : 'ChatGPT subscription not signed in yet (open the GOAT Harness auxiliary panel to sign in).';
  const claudeText = claude.available
    ? `Claude Code CLI ready (${claude.version}).`
    : 'Claude Code CLI not found.';
  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: `GOAT Harness is active. ${authText} ${claudeText} Use MCP tools \`goat_run_claude_harness\` or \`goat_review_with_openai\` when delegating work or requesting a ChatGPT-backed second opinion.`,
        },
      },
    ],
  };
}

export function evaluatePreToolUse(payload) {
  const toolName = String(payload?.toolCall?.name || '').toLowerCase();
  if (toolName !== 'run_command') {
    return { decision: 'allow' };
  }
  const cmd = String(payload?.toolCall?.args?.CommandLine || payload?.toolCall?.args?.command || '');
  for (const rule of HARD_DENY_PATTERNS) {
    if (rule.re.test(cmd)) {
      return { decision: 'deny', reason: rule.reason };
    }
  }
  for (const rule of ASK_CONFIRM_PATTERNS) {
    if (rule.re.test(cmd)) {
      return { decision: 'ask', reason: rule.reason };
    }
  }
  return { decision: 'allow' };
}

export function evaluatePostToolUse(payload) {
  const convId = payload?.conversationId || 'default';
  const toolName = String(payload?.toolCall?.name || '').toLowerCase();
  const hasError = Boolean(payload?.error);
  const args = payload?.toolCall?.args || {};

  if (EDIT_TOOLS.has(toolName) && !hasError) {
    const state = getHookState(convId);
    const filePath = String(args.Path || args.TargetFile || args.AbsolutePath || '');
    if (filePath && !state.editedFiles.includes(filePath)) {
      state.editedFiles.push(filePath);
    }
    if (!filePath || CODE_EXT_RE.test(filePath)) {
      state.dirtySinceVerify = true;
      state.stopPromptedForBatch = false;
    }
    saveHookState(convId, state);
    return {};
  }

  if (toolName === 'run_command' && !hasError) {
    const cmd = String(args.CommandLine || args.command || '');
    if (VERIFY_CMD_RE.test(cmd)) {
      const state = getHookState(convId);
      state.dirtySinceVerify = false;
      state.stopPromptedForBatch = false;
      state.lastVerifyCommand = cmd.slice(0, 200);
      state.lastVerifyAt = new Date().toISOString();
      saveHookState(convId, state);
    }
  }

  return {};
}

export function evaluateStopHook(payload) {
  const settings = getSettings();
  if (!settings.strictVerifyHook) return {};
  if (payload?.continuationActive) return {};
  if (payload?.terminationReason && payload.terminationReason !== 'NO_TOOL_CALL') return {};

  const convId = payload?.conversationId || 'default';
  const state = getHookState(convId);
  if (!state.dirtySinceVerify || state.stopPromptedForBatch) {
    return {};
  }

  const workspaces = Array.isArray(payload?.workspacePaths)
    ? payload.workspacePaths
    : payload?.cwd
      ? [payload.cwd]
      : [];
  if (!hasProjectVerifySuite(workspaces)) {
    return {};
  }

  state.stopPromptedForBatch = true;
  saveHookState(convId, state);

  return {
    decision: 'continue',
    reason:
      'GOAT Harness verification gate: source files were modified without a passing verification run afterward. Run the project tests or checks (e.g. `npm test`) before finishing.',
  };
}

export async function runHookCli(handler) {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  let payload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = {};
    }
  }
  const output = await handler(payload);
  process.stdout.write(`${JSON.stringify(output || {})}\n`);
}
