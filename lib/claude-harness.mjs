import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAnthropicProxy } from './anthropic-proxy.mjs';
import {
  fetchOpenAIModels,
  getValidOpenAIToken,
  resolveLaunchModelConfig,
} from './openai-oauth.mjs';
import { ensureLoopbackNoProxy, proxyFetch } from './proxy-fetch.mjs';
import { getRun, getSettings, normalizeReasoningEffort, saveRun } from './store.mjs';

const activeControllers = new Map(); // runId -> { abort: () => void }

export function resolveClaudeBinary(configuredPath = '') {
  const candidates = [
    configuredPath,
    process.env.CLAUDE_CODE_PATH,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(homedir(), '.local', 'bin', 'claude'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  try {
    const resolved = execFileSync('which', ['claude'], { encoding: 'utf-8', timeout: 2000 }).trim();
    if (resolved) return resolved;
  } catch {
    // Ignore PATH lookup failure; return fallback error below.
  }

  return '';
}

export function checkClaudeHealth(configuredPath = '') {
  const bin = resolveClaudeBinary(configuredPath);
  if (!bin) {
    return {
      available: false,
      path: '',
      version: '',
      error: 'Claude Code CLI (`claude`) not found in PATH or /opt/homebrew/bin/claude.',
    };
  }
  try {
    const version = execFileSync(bin, ['--version'], { encoding: 'utf-8', timeout: 3000 }).trim();
    return { available: true, path: bin, version, error: '' };
  } catch (err) {
    return {
      available: false,
      path: bin,
      version: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function extractEventSummary(event, state) {
  if (!event || typeof event !== 'object') return;

  if (event.type === 'system' && event.subtype === 'init') {
    if (event.session_id) state.claudeSessionId = event.session_id;
    return;
  }

  if (event.type === 'stream_event') {
    const ev = event.event;
    if (ev?.type === 'content_block_delta') {
      if (ev.delta?.type === 'text_delta' && ev.delta.text) {
        state.streamText += ev.delta.text;
      } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
        state.thinkingText += ev.delta.thinking;
      }
    }
    return;
  }

  if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
    for (const blk of event.message.content) {
      if (blk?.type === 'tool_use' && blk.name) {
        state.toolsUsed.push({
          id: blk.id || '',
          name: blk.name,
          inputPreview: JSON.stringify(blk.input || {}).slice(0, 240),
          at: new Date().toISOString(),
        });
      } else if (blk?.type === 'text' && blk.text && !state.streamText) {
        state.assistantFallbackText = blk.text;
      }
    }
    return;
  }

  if (event.type === 'result') {
    if (event.session_id) state.claudeSessionId = event.session_id;
    state.resultText = typeof event.result === 'string' ? event.result : '';
    state.isError = Boolean(event.is_error);
    state.numTurns = Number(event.num_turns || 0);
    state.durationMs = Number(event.duration_ms || 0);
    if (event.usage) state.usage = event.usage;
  }
}

export function cancelHarnessRun(runId) {
  const entry = activeControllers.get(runId);
  if (!entry) return false;
  entry.abort();
  return true;
}

/**
 * Executes a prompt inside Claude Code's harness (`claude -p --output-format stream-json`)
 * routed through a local Anthropic-to-OpenAI Responses API proxy.
 */
export async function runClaudeHarness({
  runId: providedRunId = '',
  prompt,
  cwd = process.cwd(),
  model = '',
  permissionMode = '',
  allowedTools = [],
  disallowedTools = [],
  appendSystemPrompt = '',
  resumeSessionId = '',
  reasoningEffort = '',
  bare = true,
  timeoutMs = 300_000,
  source = 'sidecar',
  onEvent = null,
  proxyOverride = null,
  getTokenFn = getValidOpenAIToken,
  getModelsFn = fetchOpenAIModels,
  fetchImpl = proxyFetch,
} = {}) {
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) throw new Error('Prompt must be a non-empty string.');

  let resolvedCwd = String(cwd || process.cwd()).trim() || process.cwd();
  if (resolvedCwd.startsWith('file://')) {
    resolvedCwd = fileURLToPath(resolvedCwd);
  }
  if (!existsSync(resolvedCwd) || !statSync(resolvedCwd).isDirectory()) {
    throw new Error(`Workspace directory does not exist: ${resolvedCwd}`);
  }

  const settings = getSettings();
  const effectivePermMode = permissionMode || settings.permissionMode || 'acceptEdits';
  const effectiveEffort = normalizeReasoningEffort(
    reasoningEffort || settings.reasoningEffort || 'medium'
  );
  const runId = providedRunId || `run_${Date.now()}_${randomUUID().slice(0, 8)}`;

  const runState = {
    id: runId,
    source,
    status: 'running',
    model: String(model || settings.defaultModel || ''),
    permissionMode: effectivePermMode,
    cwd: resolvedCwd,
    prompt: cleanPrompt,
    claudeSessionId: resumeSessionId || '',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    durationMs: 0,
    numTurns: 0,
    streamText: '',
    thinkingText: '',
    assistantFallbackText: '',
    resultText: '',
    stderr: '',
    error: '',
    isError: false,
    toolsUsed: [],
    usage: null,
  };
  saveRun(runState);

  let ownedProxy = null;
  let cancelled = false;
  let timedOut = false;
  let child = null;

  try {
    const claudeBin = resolveClaudeBinary(settings.claudePath);
    if (!claudeBin) {
      throw new Error('Claude Code CLI (`claude`) was not found. Install `@anthropic-ai/claude-code` or set claudePath.');
    }

    // Verify OpenAI credentials upfront before spawning Claude Code.
    await getTokenFn(fetchImpl);

    const launchConfig = await resolveLaunchModelConfig({
      requestedModel: model,
      defaultModel: settings.defaultModel,
      getModelsFn,
      fetchImpl,
    });
    const selectedModel = launchConfig.selectedModel;
    const modelTiers = launchConfig.tiers;
    if (!selectedModel) {
      throw new Error('No OpenAI model selected or returned by /v1/models.');
    }

    runState.model = selectedModel;
    saveRun(runState);

    ownedProxy = proxyOverride
      ? null
      : await startAnthropicProxy({
          defaultModel: selectedModel,
          modelTiers,
          models: launchConfig.models,
          reasoningEffort: effectiveEffort,
          source,
          getTokenFn,
          getModelsFn,
          fetchImpl,
        });
    const proxy = proxyOverride || ownedProxy;

    // Read optional project CLAUDE.md / AGENTS.md when --bare disables auto-discovery.
    let extraSystem = appendSystemPrompt || '';
    if (bare) {
      const contextFiles = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']
        .map((name) => join(resolvedCwd, name))
        .filter((p) => existsSync(p));
      if (contextFiles.length) {
        const snippets = contextFiles
          .map((p) => {
            try {
              return `## ${p}\n${readFileSync(p, 'utf-8').slice(0, 6000)}`;
            } catch {
              return '';
            }
          })
          .filter(Boolean)
          .join('\n\n');
        if (snippets) {
          extraSystem = extraSystem ? `${extraSystem}\n\n${snippets}` : snippets;
        }
      }
    }

    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model',
      selectedModel,
      '--permission-mode',
      effectivePermMode,
      '--permission-prompts',
      'none',
    ];

    const contextWindow = Number(launchConfig.contextWindow || 0);
    const harnessEnv = {
      ANTHROPIC_BASE_URL: proxy.baseUrl,
      ANTHROPIC_API_KEY: proxy.token,
      ANTHROPIC_AUTH_TOKEN: proxy.token,
      ANTHROPIC_MODEL: selectedModel,
      ANTHROPIC_SMALL_FAST_MODEL: modelTiers.haiku || selectedModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: modelTiers.opus || selectedModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: modelTiers.sonnet || selectedModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: modelTiers.haiku || selectedModel,
      CLAUDE_CODE_AUTO_MODE_SERVER: '0',
      CLAUDE_CODE_DISABLE_FAST_MODE: '1',
      ...(contextWindow > 0 ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextWindow) } : {}),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };

    // Pin proxy env via --settings (and skip settings files in bare mode) so a
    // global `~/.claude/settings.json` install cannot override the ephemeral proxy URL.
    if (bare) {
      args.push('--bare', '--setting-sources', '');
    }
    args.push('--settings', JSON.stringify({ env: harnessEnv }));
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    if (Array.isArray(allowedTools) && allowedTools.length) {
      args.push('--allowedTools', ...allowedTools);
    }
    if (Array.isArray(disallowedTools) && disallowedTools.length) {
      args.push('--disallowedTools', ...disallowedTools);
    }
    if (extraSystem) args.push('--append-system-prompt', extraSystem);
    args.push('--', cleanPrompt);

    const env = ensureLoopbackNoProxy({
      ...process.env,
      ...harnessEnv,
    });

    const exitInfo = await new Promise((resolve, reject) => {
      child = spawn(claudeBin, args, {
        cwd: resolvedCwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      activeControllers.set(runId, {
        abort: () => {
          cancelled = true;
          try {
            child.kill('SIGTERM');
          } catch {
            // Ignore kill errors.
          }
        },
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // Ignore timeout kill errors.
        }
      }, timeoutMs);

      let stdoutBuf = '';
      let lastPersistAt = 0;

      const persistThrottled = (force = false) => {
        const now = Date.now();
        if (force || now - lastPersistAt > 350) {
          lastPersistAt = now;
          saveRun(runState);
        }
      };

      child.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString('utf-8');
        let idx = stdoutBuf.indexOf('\n');
        while (idx !== -1) {
          const line = stdoutBuf.slice(0, idx).trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (line) {
            try {
              const ev = JSON.parse(line);
              extractEventSummary(ev, runState);
              if (onEvent) onEvent(ev, runState);
              persistThrottled(ev.type === 'result' || ev.type === 'assistant');
            } catch {
              // Ignore non-JSON diagnostic lines.
            }
          }
          idx = stdoutBuf.indexOf('\n');
        }
      });

      child.stderr.on('data', (chunk) => {
        runState.stderr += chunk.toString('utf-8');
        if (runState.stderr.length > 12_000) {
          runState.stderr = runState.stderr.slice(-12_000);
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (stdoutBuf.trim()) {
          try {
            const ev = JSON.parse(stdoutBuf.trim());
            extractEventSummary(ev, runState);
            if (onEvent) onEvent(ev, runState);
          } catch {
            // Ignore trailing incomplete line.
          }
        }
        resolve({ code, signal });
      });
    });

    runState.finishedAt = new Date().toISOString();
    if (!runState.durationMs) {
      runState.durationMs = Date.parse(runState.finishedAt) - Date.parse(runState.startedAt);
    }

    const finalText = runState.resultText || runState.streamText || runState.assistantFallbackText;
    runState.resultText = finalText;

    if (cancelled) {
      runState.status = 'cancelled';
      runState.error = 'Run was cancelled.';
    } else if (timedOut) {
      runState.status = 'error';
      runState.error = `Claude Code harness timed out after ${Math.round(timeoutMs / 1000)}s.`;
    } else if (runState.isError || exitInfo.code !== 0) {
      runState.status = 'error';
      runState.error =
        runState.error ||
        (runState.isError ? finalText : '') ||
        runState.stderr.trim() ||
        `Claude exited with code ${exitInfo.code} (${exitInfo.signal || 'no signal'})`;
    } else {
      runState.status = 'completed';
    }

    saveRun(runState);
    return getRun(runId) || runState;
  } catch (err) {
    runState.finishedAt = new Date().toISOString();
    runState.status = 'error';
    runState.error = err instanceof Error ? err.message : String(err);
    saveRun(runState);
    throw err;
  } finally {
    activeControllers.delete(runId);
    if (ownedProxy) {
      await ownedProxy.close();
    }
  }
}
