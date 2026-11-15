import {
  cancelHarnessRun,
  checkClaudeHealth,
  runClaudeHarness,
} from './claude-harness.mjs';
import {
  cancelPendingOAuth,
  fetchOpenAIModels,
  getAuthSummary,
  selectModelTiers,
  signOutChatGPT,
  startSignInWithChatGPT,
  waitForPendingOAuth,
} from './openai-oauth.mjs';
import {
  getRun,
  getSettings,
  getUsageSummary,
  isMainModule,
  listRuns,
  resetUsageStats,
  saveSettings,
  VALID_REASONING_EFFORTS,
} from './store.mjs';
import { syncInstalledClaudeModel } from './claude-installer.mjs';

export const MCP_TOOLS = [
  {
    name: 'goat_status',
    description:
      'Check GOAT Harness status: Sign in with ChatGPT subscription connection, Claude Code CLI health, active default OpenAI model, and recent runs.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'goat_login_chatgpt',
    description:
      'Start, wait for, or cancel the official "Sign in with ChatGPT" OAuth browser login flow and store subscription tokens locally for Claude Code and Antigravity.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'wait', 'cancel'],
          description:
            'start (default): launch browser OAuth and return auth_url; wait: wait for active browser callback; cancel: abort pending login.',
        },
        open_browser: {
          type: 'boolean',
          description: 'When action is start, automatically open the default browser (default: true).',
        },
        wait_sec: {
          type: 'number',
          description:
            'Seconds to wait for callback completion (0 returns auth_url immediately; 1-300 waits). Defaults to 0 for start, 120 for wait.',
        },
        force: {
          type: 'boolean',
          description: 'Force a new login flow even if already signed in with ChatGPT.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'goat_logout_chatgpt',
    description: 'Sign out and clear stored ChatGPT subscription OAuth tokens from GOAT Harness.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'goat_set_model',
    description: 'Save default OpenAI model and/or reasoning effort in GOAT Harness settings.',
    inputSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: 'OpenAI model slug to set as default (e.g. from goat_list_models).',
        },
        reasoning_effort: {
          type: 'string',
          enum: VALID_REASONING_EFFORTS,
          description: 'Default reasoning effort for OpenAI /v1/responses calls.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'goat_list_models',
    description:
      'List available OpenAI models from the connected ChatGPT subscription account (or API key fallback).',
    inputSchema: {
      type: 'object',
      properties: {
        force_refresh: {
          type: 'boolean',
          description: 'Bypass the 60s model catalog cache and fetch fresh models from OpenAI.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'goat_run_claude_harness',
    description:
      'Delegate a coding, refactoring, debugging, or analysis task to Claude Code CLI harness powered by your ChatGPT subscription model via local Anthropic-to-OpenAI proxy.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Task instructions for Claude Code harness.',
        },
        cwd: {
          type: 'string',
          description: 'Absolute workspace directory path where Claude Code should operate.',
        },
        model: {
          type: 'string',
          description: 'Optional OpenAI model slug override (defaults to settings.defaultModel or first available model).',
        },
        reasoning_effort: {
          type: 'string',
          enum: VALID_REASONING_EFFORTS,
          description: 'Optional OpenAI reasoning effort override for this run.',
        },
        permission_mode: {
          type: 'string',
          enum: ['plan', 'acceptEdits', 'dontAsk', 'bypassPermissions'],
          description: 'Claude Code permission mode (default: acceptEdits; use plan for read-only exploration).',
        },
        resume_session_id: {
          type: 'string',
          description: 'Optional Claude session_id returned from an earlier run to resume context.',
        },
        allowed_tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of allowed Claude Code tools/patterns (e.g. ["Read", "Grep", "Bash(npm test *)"]).',
        },
        timeout_sec: {
          type: 'number',
          description: 'Timeout in seconds (default: 300, max: 900).',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'goat_review_with_openai',
    description:
      'Run a read-only second-opinion code review or architecture audit using Claude Code harness in plan mode + your ChatGPT subscription model.',
    inputSchema: {
      type: 'object',
      properties: {
        focus: {
          type: 'string',
          description: 'What to review (e.g. "Review staged git diff for bugs, edge cases, and security issues").',
        },
        cwd: {
          type: 'string',
          description: 'Absolute workspace directory path to inspect.',
        },
        model: {
          type: 'string',
          description: 'Optional OpenAI model slug override.',
        },
      },
      required: ['focus'],
      additionalProperties: false,
    },
  },
  {
    name: 'goat_cancel_run',
    description: 'Cancel an active GOAT Harness run by run_id.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: {
          type: 'string',
          description: 'Identifier of the active run to cancel.',
        },
      },
      required: ['run_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'goat_usage',
    description:
      'Inspect local OpenAI token usage (today, last 7/30 days, all-time, per-model breakdown, last request, and any 429/quota error) plus the ChatGPT Settings URL for server-side weekly caps.',
    inputSchema: {
      type: 'object',
      properties: {
        reset: {
          type: 'boolean',
          description: 'When true, resets local usage counters before returning the summary.',
        },
      },
      additionalProperties: false,
    },
  },
];

function textResult(data, isError = false) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

export function createMcpDispatcher(deps = {}) {
  const runHarness = deps.runClaudeHarness || runClaudeHarness;
  const listModels = deps.fetchOpenAIModels || fetchOpenAIModels;
  const authSummary = deps.getAuthSummary || getAuthSummary;
  const claudeHealth = deps.checkClaudeHealth || checkClaudeHealth;
  const cancelRun = deps.cancelHarnessRun || cancelHarnessRun;
  const startOAuth = deps.startSignInWithChatGPT || startSignInWithChatGPT;
  const waitLogin = deps.waitForPendingOAuth || waitForPendingOAuth;
  const cancelOAuth = deps.cancelPendingOAuth || cancelPendingOAuth;
  const signOut = deps.signOutChatGPT || signOutChatGPT;
  const updateSettings = deps.saveSettings || saveSettings;
  const readUsage = deps.getUsageSummary || getUsageSummary;
  const resetUsage = deps.resetUsageStats || resetUsageStats;

  async function buildConnectedAuthPayload(outcome) {
    const settings = getSettings();
    let models = [];
    let modelsError = '';
    try {
      const catalog = await listModels({ forceRefresh: true });
      models = catalog.models || [];
    } catch (err) {
      modelsError = err instanceof Error ? err.message : String(err);
    }
    const auth = authSummary();
    return {
      status: 'connected',
      auth,
      account: outcome?.account || auth.account,
      default_model: settings.defaultModel || models[0]?.slug || '',
      models,
      ...(modelsError ? { models_error: modelsError } : {}),
    };
  }

  async function handleToolCall(name, args = {}) {
    if (name === 'goat_status') {
      const settings = getSettings();
      const auth = authSummary();
      const claude = claudeHealth(settings.claudePath);
      const runs = listRuns(5).map((r) => ({
        id: r.id,
        status: r.status,
        model: r.model,
        source: r.source,
        startedAt: r.startedAt,
        durationMs: r.durationMs,
      }));
      return textResult({
        auth,
        claude,
        settings: {
          defaultModel: settings.defaultModel,
          permissionMode: settings.permissionMode,
          reasoningEffort: settings.reasoningEffort,
          strictVerifyHook: settings.strictVerifyHook,
        },
        usage: readUsage(),
        recentRuns: runs,
      });
    }

    if (name === 'goat_login_chatgpt') {
      const action = String(args?.action || 'start').trim();
      if (!['start', 'wait', 'cancel'].includes(action)) {
        throw new Error(`Invalid action "${action}". Expected "start", "wait", or "cancel".`);
      }

      if (action === 'cancel') {
        cancelOAuth();
        return textResult({ status: 'cancelled', auth: authSummary() });
      }

      if (action === 'wait') {
        const waitSec = Math.min(300, Math.max(1, Number(args?.wait_sec ?? 120)));
        const outcome = await waitLogin(waitSec * 1000);
        if (outcome?.ok) {
          return textResult(await buildConnectedAuthPayload(outcome));
        }
        if (outcome?.pending) {
          return textResult({
            status: 'pending',
            auth_url: outcome.authUrl || '',
            redirect_uri: outcome.redirectUri || '',
            message: outcome.error || 'Still waiting for browser sign-in callback.',
          });
        }
        return textResult(
          {
            status: 'error',
            error: outcome?.error || 'ChatGPT sign-in did not complete.',
          },
          true
        );
      }

      const force = Boolean(args?.force);
      const currentAuth = authSummary();
      if (currentAuth.mode === 'oauth' && !force) {
        return textResult({
          status: 'already_connected',
          auth: currentAuth,
          message: 'Already signed in with ChatGPT. Pass force: true to start a new login.',
        });
      }

      const openBrowser = args?.open_browser !== false;
      const started = await startOAuth({ openBrowser });
      started.completionPromise?.catch?.(() => {});

      const waitSec = Math.min(300, Math.max(0, Number(args?.wait_sec ?? 0)));
      if (waitSec > 0) {
        const outcome = await waitLogin(waitSec * 1000);
        if (outcome?.ok) {
          return textResult(await buildConnectedAuthPayload(outcome));
        }
        if (outcome?.pending) {
          return textResult({
            status: 'pending',
            browser_opened: openBrowser,
            auth_url: started.authUrl,
            redirect_uri: started.redirectUri,
            message: outcome.error || 'Still waiting for browser callback.',
          });
        }
        return textResult(
          {
            status: 'error',
            auth_url: started.authUrl,
            error: outcome?.error || 'ChatGPT sign-in failed.',
          },
          true
        );
      }

      return textResult({
        status: 'pending',
        browser_opened: openBrowser,
        auth_url: started.authUrl,
        redirect_uri: started.redirectUri,
        next_step:
          'Open auth_url in your browser if it did not open automatically, then call goat_login_chatgpt with action="wait".',
      });
    }

    if (name === 'goat_logout_chatgpt') {
      signOut();
      return textResult({ status: 'signed_out', auth: authSummary() });
    }

    if (name === 'goat_set_model') {
      const patch = {};
      if (typeof args?.model === 'string' && args.model.trim()) {
        patch.defaultModel = args.model.trim();
      }
      if (typeof args?.reasoning_effort === 'string' && args.reasoning_effort.trim()) {
        const effort = args.reasoning_effort.trim().toLowerCase();
        if (!VALID_REASONING_EFFORTS.includes(effort)) {
          throw new Error(`reasoning_effort must be one of: ${VALID_REASONING_EFFORTS.join(', ')}.`);
        }
        patch.reasoningEffort = effort;
      }
      if (!Object.keys(patch).length) {
        throw new Error('Provide `model` and/or `reasoning_effort` to update.');
      }
      const updated = updateSettings(patch);
      if (patch.defaultModel || patch.reasoningEffort) {
        try {
          syncInstalledClaudeModel({
            model: updated.defaultModel,
            effort: updated.reasoningEffort,
          });
        } catch {
          // Non-fatal if Claude Code settings cannot be synced.
        }
      }
      return textResult({
        ok: true,
        settings: {
          defaultModel: updated.defaultModel,
          reasoningEffort: updated.reasoningEffort,
          permissionMode: updated.permissionMode,
        },
      });
    }

    if (name === 'goat_list_models') {
      const { models, mode, account } = await listModels({
        forceRefresh: Boolean(args?.force_refresh),
      });
      const settings = getSettings();
      const activeDefault = settings.defaultModel || models[0]?.slug || '';
      return textResult({
        authMode: mode,
        accountEmail: account?.email || '',
        defaultModel: activeDefault,
        tiers: selectModelTiers(models, activeDefault),
        models,
      });
    }

    if (name === 'goat_run_claude_harness') {
      const timeoutSec = Math.min(900, Math.max(10, Number(args?.timeout_sec || 300)));
      const run = await runHarness({
        prompt: args?.prompt,
        cwd: args?.cwd || process.cwd(),
        model: args?.model || '',
        reasoningEffort: args?.reasoning_effort || '',
        permissionMode: args?.permission_mode || '',
        resumeSessionId: args?.resume_session_id || '',
        allowedTools: Array.isArray(args?.allowed_tools) ? args.allowed_tools : [],
        timeoutMs: timeoutSec * 1000,
        source: 'mcp',
      });
      return textResult(
        {
          run_id: run.id,
          status: run.status,
          model: run.model,
          claude_session_id: run.claudeSessionId,
          duration_ms: run.durationMs,
          num_turns: run.numTurns,
          tools_used: run.toolsUsed,
          usage: run.usage,
          result: run.resultText,
          error: run.error || undefined,
        },
        run.status === 'error'
      );
    }

    if (name === 'goat_review_with_openai') {
      const focus = String(args?.focus || '').trim();
      if (!focus) throw new Error('`focus` is required.');
      const reviewPrompt = [
        'Perform a thorough, read-only engineering code review.',
        'Do NOT modify any files. Inspect relevant files, git diff/status if helpful, and cite exact file paths and line numbers for every finding.',
        `Review focus: ${focus}`,
      ].join('\n\n');

      const run = await runHarness({
        prompt: reviewPrompt,
        cwd: args?.cwd || process.cwd(),
        model: args?.model || '',
        permissionMode: 'plan',
        allowedTools: ['Read', 'Glob', 'Grep', 'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)'],
        source: 'mcp-review',
      });
      return textResult(
        {
          run_id: run.id,
          status: run.status,
          model: run.model,
          claude_session_id: run.claudeSessionId,
          duration_ms: run.durationMs,
          review: run.resultText,
          error: run.error || undefined,
        },
        run.status === 'error'
      );
    }

    if (name === 'goat_cancel_run') {
      const runId = String(args?.run_id || '').trim();
      const cancelled = cancelRun(runId);
      const run = getRun(runId);
      return textResult({ run_id: runId, cancelled, status: run?.status || 'unknown' });
    }

    if (name === 'goat_usage') {
      let reset = false;
      if (args?.reset) {
        await resetUsage();
        reset = true;
      }
      return textResult({ reset, usage: readUsage() });
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  return async function dispatch(msg) {
    if (!msg || typeof msg !== 'object') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }

    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      return null;
    }

    try {
      let result;
      if (method === 'initialize') {
        const clientProto = params?.protocolVersion;
        const supported = ['2025-03-26', '2024-11-05'];
        result = {
          protocolVersion: supported.includes(clientProto) ? clientProto : '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'goat-harness-claude', version: '0.1.0' },
        };
      } else if (method === 'ping') {
        result = {};
      } else if (method === 'tools/list') {
        result = { tools: MCP_TOOLS };
      } else if (method === 'tools/call') {
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        try {
          result = await handleToolCall(toolName, toolArgs);
        } catch (toolErr) {
          result = textResult(
            toolErr instanceof Error ? toolErr.message : String(toolErr),
            true
          );
        }
      } else if (method === 'resources/list') {
        result = { resources: [] };
      } else if (method === 'prompts/list') {
        result = { prompts: [] };
      } else {
        if (isNotification) return null;
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
      }

      if (isNotification) return null;
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      if (isNotification) return null;
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  };
}

function startStdioTransport() {
  const dispatch = createMcpDispatcher();
  let buffer = Buffer.alloc(0);
  let framing = 'ndjson';

  const send = (obj) => {
    if (!obj) return;
    const json = JSON.stringify(obj);
    if (framing === 'lsp') {
      const bytes = Buffer.byteLength(json, 'utf-8');
      process.stdout.write(`Content-Length: ${bytes}\r\n\r\n${json}`);
    } else {
      process.stdout.write(`${json}\n`);
    }
  };

  const processMessage = async (rawJson) => {
    let msg;
    try {
      msg = JSON.parse(rawJson);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const response = await dispatch(msg);
    send(response);
  };

  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length > 0) {
      const asText = buffer.toString('utf-8');
      if (asText.startsWith('Content-Length:')) {
        framing = 'lsp';
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        const headerText = buffer.slice(0, headerEnd).toString('utf-8');
        const match = /Content-Length:\s*(\d+)/i.exec(headerText);
        if (!match) {
          buffer = buffer.slice(headerEnd + 4);
          continue;
        }
        const len = Number(match[1]);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + len) break;
        const body = buffer.slice(bodyStart, bodyStart + len).toString('utf-8');
        buffer = buffer.slice(bodyStart + len);
        void processMessage(body);
        continue;
      }

      const nlIdx = buffer.indexOf('\n');
      if (nlIdx === -1) break;
      const line = buffer.slice(0, nlIdx).toString('utf-8').trim();
      buffer = buffer.slice(nlIdx + 1);
      if (line) void processMessage(line);
    }
  });

  process.stdin.resume();
}

if (isMainModule(import.meta.url)) {
  startStdioTransport();
}
