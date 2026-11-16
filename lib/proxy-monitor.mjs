import http from 'node:http';
import { getAuthSummary } from './openai-oauth.mjs';
import { getDaemonStatus, getProxyConfigPath } from './proxy-daemon.mjs';
import { formatTokenCount, getSettings, readJsonSafe } from './store.mjs';

function formatDurationMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n < 1000) return `${Math.round(n)}ms`;
  const secs = n / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = Math.round(secs % 60);
  if (mins < 60) return `${mins}m${String(remSecs).padStart(2, '0')}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h${String(remMins).padStart(2, '0')}m`;
}

function formatClockTime(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '--:--:--';
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((v) => String(v).padStart(2, '0'))
    .join(':');
}

function padCell(value, width) {
  const s = String(value ?? '');
  if (s.length >= width) return s.slice(0, width - 1) + (width > 3 ? '…' : '');
  return s.padEnd(width, ' ');
}

/**
 * Fetches a point-in-time telemetry snapshot from a running `goat-proxy` instance.
 */
export function fetchProxyMonitorSnapshot({ baseUrl, token = '', timeoutMs = 1500 }) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL('/_goat/snapshot', baseUrl);
    } catch (err) {
      reject(err);
      return;
    }

    const req = http.request(
      url,
      {
        method: 'GET',
        timeout: timeoutMs,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode !== 200) {
            reject(new Error(`Proxy monitor HTTP ${res.statusCode}: ${raw}`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(new Error(`Invalid monitor JSON: ${err.message}`));
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('Proxy monitor request timed out'));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Formats a proxy telemetry snapshot into a readable fixed-width terminal dashboard.
 */
export function formatMonitorScreen(
  snapshot,
  { baseUrl = '', account = '', defaultModel = '', reasoningEffort = '', maxRows = 15, now = Date.now() } = {}
) {
  const stats = snapshot?.stats || {};
  const active = Array.isArray(snapshot?.active) ? snapshot.active : [];
  const recent = Array.isArray(snapshot?.recent) ? snapshot.recent : [];

  const headerLines = [
    `GOAT Proxy Monitor  |  ${baseUrl || `http://127.0.0.1:${snapshot?.port || 0}`} (pid ${snapshot?.pid || '-'})  |  up ${formatDurationMs(snapshot?.uptimeMs || 0)}`,
    `Account: ${account || 'connected'}  |  Default: ${defaultModel || '(auto)'} (${reasoningEffort || 'medium'})`,
    `Requests: ${stats.totalRequests || 0} total | ${stats.activeRequests || 0} active | ${stats.completedRequests || 0} ok | ${stats.errorRequests || 0} err | ${stats.fallbackRecoveredRequests || 0} auto-400-fixed | avg TTFT ${formatDurationMs(stats.avgTtftMs || 0)}`,
    `Tokens  : in ${formatTokenCount(stats.inputTokens || 0)} (cached ${stats.cacheHitPct || 0}%) | out ${formatTokenCount(stats.outputTokens || 0)} (reas ${formatTokenCount(stats.reasoningTokens || 0)}) | tools ${stats.toolCalls || 0} | web ${stats.webSearchCalls || 0}`,
    '',
  ];

  const rows = [...active, ...recent].slice(0, maxRows);
  const cols =
    `${padCell('TIME', 10)}${padCell('MODEL', 16)}${padCell('EFFORT', 9)}${padCell('TTFT', 8)}${padCell('LAT', 8)}${padCell('IN / CACHE', 16)}${padCell('OUT (REAS)', 15)}${padCell('TOOLS', 8)}STATUS`;

  const rowLines = rows.map((entry) => {
    const timeStr = formatClockTime(entry.startedAt);
    const modelStr = entry.targetModel || entry.requestedModel || '-';
    const effortStr = entry.effort ? `${entry.effort}${entry.fastTier ? '*' : ''}` : '-';
    const ttftStr = entry.ttftMs != null ? formatDurationMs(entry.ttftMs) : '-';
    const latStr =
      entry.latencyMs != null
        ? formatDurationMs(entry.latencyMs)
        : formatDurationMs(Math.max(0, now - (entry.startedAt || now)));
    const cachePct =
      entry.inputTokens > 0 ? `${Math.round((entry.cachedTokens / entry.inputTokens) * 100)}%` : '-';
    const inStr =
      entry.inputTokens > 0 ? `${formatTokenCount(entry.inputTokens)} (${cachePct})` : '-';
    const outStr =
      entry.outputTokens > 0 || entry.reasoningTokens > 0
        ? `${formatTokenCount(entry.outputTokens)} (${formatTokenCount(entry.reasoningTokens)})`
        : '-';
    const toolsStr =
      entry.toolCalls || entry.webSearchCalls
        ? `${entry.toolCalls || 0}${entry.webSearchCalls ? `+w${entry.webSearchCalls}` : ''}`
        : '-';
    const statusParts = [entry.status || '-'];
    if (entry.fallbackCount > 0) statusParts.push(`400x${entry.fallbackCount}`);
    if (entry.error) statusParts.push(entry.error.slice(0, 28));
    return (
      padCell(timeStr, 10) +
      padCell(modelStr, 16) +
      padCell(effortStr, 9) +
      padCell(ttftStr, 8) +
      padCell(latStr, 8) +
      padCell(inStr, 16) +
      padCell(outStr, 15) +
      padCell(toolsStr, 8) +
      statusParts.join(' ')
    );
  });

  if (!rows.length) {
    rowLines.push('Waiting for Claude Code requests... (note: * on effort indicates fast-tier acceleration)');
  } else {
    rowLines.push('', 'Legend: effort* = fast-tier / utility auto-accelerated | +wN = built-in web_search calls | q / Ctrl+C to quit');
  }

  return [...headerLines, cols, ...rowLines].join('\n') + '\n';
}

/**
 * Streams or prints the live proxy telemetry dashboard for `goat-proxy monitor` and `goat-claude top`.
 */
export async function runProxyMonitor({
  once = false,
  json = false,
  baseUrl: providedBaseUrl = '',
  token: providedToken = '',
  maxRows = 15,
  stdout = process.stdout,
  stderr = process.stderr,
  stdin = process.stdin,
  getDaemonStatusFn = getDaemonStatus,
  getSettingsFn = getSettings,
  getAuthSummaryFn = getAuthSummary,
} = {}) {
  const cfg = readJsonSafe(getProxyConfigPath(), null);
  let baseUrl = providedBaseUrl || cfg?.baseUrl || '';
  const token = providedToken || cfg?.token || '';

  if (!providedBaseUrl) {
    const status = await getDaemonStatusFn();
    if (!status.running || !status.baseUrl) {
      stderr.write('Proxy daemon is not running. Start it with: goat-proxy start (or goat-claude install)\n');
      return 1;
    }
    baseUrl = status.baseUrl;
  }

  const readMeta = () => {
    const s = getSettingsFn();
    const auth = getAuthSummaryFn();
    return {
      baseUrl,
      account: auth?.account?.email || auth?.account?.name || auth?.mode || '',
      defaultModel: s?.defaultModel || '',
      reasoningEffort: s?.reasoningEffort || 'medium',
      maxRows,
    };
  };

  if (once) {
    const snap = await fetchProxyMonitorSnapshot({ baseUrl, token });
    if (json) {
      stdout.write(`${JSON.stringify(snap, null, 2)}\n`);
    } else {
      stdout.write(formatMonitorScreen(snap, readMeta()));
    }
    return 0;
  }

  let latestSnapshot = await fetchProxyMonitorSnapshot({ baseUrl, token });
  const render = () => {
    if (json) {
      stdout.write(`${JSON.stringify(latestSnapshot)}\n`);
      return;
    }
    if (stdout.isTTY) stdout.write('\x1b[2J\x1b[H');
    stdout.write(formatMonitorScreen(latestSnapshot, readMeta()));
  };
  render();

  return await new Promise((resolve) => {
    let closed = false;
    let sseReq = null;
    let refreshTimer = null;

    const cleanup = (code = 0) => {
      if (closed) return;
      closed = true;
      if (refreshTimer) clearInterval(refreshTimer);
      if (sseReq) sseReq.destroy();
      if (stdin && typeof stdin.off === 'function') {
        stdin.off('data', onStdin);
      }
      if (stdin?.isTTY && typeof stdin.setRawMode === 'function') {
        try {
          stdin.setRawMode(false);
        } catch {
          // Ignore TTY restore errors.
        }
      }
      process.off('SIGINT', onSig);
      process.off('SIGTERM', onSig);
      resolve(code);
    };

    const onSig = () => cleanup(0);
    const onStdin = (chunk) => {
      const text = String(chunk || '');
      if (text === 'q' || text === 'Q' || text === '\x03') {
        cleanup(0);
      }
    };

    process.on('SIGINT', onSig);
    process.on('SIGTERM', onSig);
    if (stdin && typeof stdin.on === 'function') {
      if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
        try {
          stdin.setRawMode(true);
          stdin.resume?.();
        } catch {
          // Ignore raw mode errors in non-interactive shells.
        }
      }
      stdin.on('data', onStdin);
    }

    const url = new URL('/_goat/events', baseUrl);
    sseReq = http.request(
      url,
      {
        method: 'GET',
        headers: token ? { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } : { Accept: 'text/event-stream' },
      },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk.toString('utf-8').replace(/\r\n/g, '\n');
          let idx = buf.indexOf('\n\n');
          while (idx !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let eventName = 'message';
            const dataLines = [];
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) eventName = line.slice(6).trim();
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
            }
            if (eventName === 'snapshot' && dataLines.length) {
              try {
                latestSnapshot = JSON.parse(dataLines.join('\n'));
                render();
              } catch {
                // Ignore malformed SSE event payload.
              }
            }
            idx = buf.indexOf('\n\n');
          }
        });
        res.on('end', () => cleanup(0));
        res.on('error', () => cleanup(0));
      }
    );
    sseReq.on('error', () => cleanup(1));
    sseReq.end();

    if (!json && stdout.isTTY) {
      refreshTimer = setInterval(() => {
        if (!closed) render();
      }, 1000);
      refreshTimer.unref?.();
    }
  });
}
