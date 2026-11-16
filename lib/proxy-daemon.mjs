import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAnthropicProxy } from './anthropic-proxy.mjs';
import { parseScutilProxyOutput } from './proxy-fetch.mjs';
import { getStateDir, readJsonSafe, writeJsonAtomic } from './store.mjs';

export const DEFAULT_PROXY_PORT = 47289;
export const LAUNCH_AGENT_LABEL = 'com.goat-harness.proxy';
export const SYSTEMD_SERVICE_NAME = 'goat-harness-proxy.service';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

export function getProxyScriptPath() {
  return join(REPO_ROOT, 'bin', 'goat-proxy.mjs');
}

export function getProxyConfigPath() {
  return join(getStateDir(), 'proxy.json');
}

export function getProxyPidPath() {
  return join(getStateDir(), 'proxy.pid');
}

export function getProxyLogPath() {
  return join(getStateDir(), 'proxy.log');
}

export function getLaunchAgentPath(homeDir = homedir()) {
  return join(homeDir, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

export function getSystemdUnitPath(homeDir = homedir()) {
  return join(homeDir, '.config', 'systemd', 'user', SYSTEMD_SERVICE_NAME);
}

function escapeSystemdArg(str) {
  const s = String(str ?? '');
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

function escapeXml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&apos;';
      default:
        return ch;
    }
  });
}

export function ensureProxyConfig({ preferredPort = DEFAULT_PROXY_PORT } = {}) {
  const cfgPath = getProxyConfigPath();
  const existing = readJsonSafe(cfgPath, null);
  if (
    existing &&
    typeof existing === 'object' &&
    typeof existing.token === 'string' &&
    existing.token.length >= 16 &&
    Number.isInteger(existing.port) &&
    existing.port > 0
  ) {
    return {
      ...existing,
      baseUrl: `http://127.0.0.1:${existing.port}`,
    };
  }

  const normalizedPort =
    preferredPort === undefined || preferredPort === null
      ? DEFAULT_PROXY_PORT
      : Number(preferredPort);
  const next = {
    version: 1,
    port: Number.isFinite(normalizedPort) && normalizedPort >= 0 ? normalizedPort : DEFAULT_PROXY_PORT,
    token: (existing && typeof existing.token === 'string' && existing.token.length >= 16)
      ? existing.token
      : randomBytes(24).toString('hex'),
    baseUrl:
      Number.isFinite(normalizedPort) && normalizedPort > 0
        ? `http://127.0.0.1:${normalizedPort}`
        : '',
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(cfgPath, next, 0o600);
  return next;
}

export function probeProxyHealth(baseUrl, { timeoutMs = 1200 } = {}) {
  return new Promise((resolveProbe) => {
    let url;
    try {
      url = new URL('/health', baseUrl);
    } catch (err) {
      resolveProbe({ running: false, error: err.message });
      return;
    }

    const req = http.get(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolveProbe({ running: false, status: res.statusCode });
            return;
          }
          try {
            const parsed = JSON.parse(body);
            resolveProbe({
              running: Boolean(parsed?.ok),
              pid: Number(parsed?.pid) || 0,
              port: Number(parsed?.port) || Number(url.port) || 0,
              dynamicSettings: Boolean(parsed?.dynamicSettings),
            });
          } catch {
            resolveProbe({ running: false, error: 'Invalid health response' });
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('Health check timed out'));
    });
    req.on('error', (err) => {
      resolveProbe({ running: false, error: err.message });
    });
  });
}

function hasMacSystemProxy() {
  if (process.platform !== 'darwin') return false;
  try {
    const raw = execFileSync('scutil', ['--proxy'], { encoding: 'utf-8', timeout: 800 });
    const parsed = parseScutilProxyOutput(raw);
    return Boolean(parsed.HTTPS_PROXY || parsed.HTTP_PROXY || parsed.ALL_PROXY);
  } catch {
    return false;
  }
}

export function buildLaunchAgentPlist({
  nodeBin = process.execPath,
  proxyScriptPath = getProxyScriptPath(),
  logPath = getProxyLogPath(),
  envVars = {},
} = {}) {
  const envEntries = Object.entries(envVars)
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
    .map(
      ([k, v]) =>
        `      <key>${escapeXml(k)}</key>\n      <string>${escapeXml(String(v))}</string>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${escapeXml(nodeBin)}</string>
      <string>${escapeXml(proxyScriptPath)}</string>
      <string>serve</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(logPath)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
  </dict>
</plist>
`;
}

/**
 * Renders a systemd user unit file for keeping `goat-proxy` running on Linux desktops and WSL.
 */
export function buildSystemdServiceUnit({
  nodeBin = process.execPath,
  proxyScriptPath = getProxyScriptPath(),
  logPath = getProxyLogPath(),
  envVars = {},
} = {}) {
  const envLines = Object.entries(envVars)
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
    .map(([k, v]) => `Environment=${escapeSystemdArg(`${k}=${String(v)}`)}`);

  return [
    '[Unit]',
    'Description=GOAT Harness Local Anthropic-to-OpenAI Proxy Daemon',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${escapeSystemdArg(nodeBin)} ${escapeSystemdArg(proxyScriptPath)} serve`,
    'Restart=always',
    'RestartSec=2',
    `StandardOutput=append:${logPath}`,
    `StandardError=append:${logPath}`,
    ...envLines,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function buildDaemonEnvVars() {
  const vars = {
    HOME: homedir(),
    PATH: process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
  };
  if (process.env.GOAT_HARNESS_HOME) {
    vars.GOAT_HARNESS_HOME = process.env.GOAT_HARNESS_HOME;
  }
  // If macOS System Proxy is configured, scutil --proxy is queried dynamically by proxyFetch;
  // only snapshot shell proxy env vars when no System Proxy exists.
  if (!hasMacSystemProxy()) {
    for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy']) {
      if (process.env[key]) vars[key] = process.env[key];
    }
  }
  return vars;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function stopProcessFromPidFile(pidPath = getProxyPidPath()) {
  if (!existsSync(pidPath)) return false;
  let stopped = false;
  try {
    const pid = Number(readFileSync(pidPath, 'utf-8').trim());
    if (isPidAlive(pid) && pid !== process.pid) {
      process.kill(pid, 'SIGTERM');
      stopped = true;
    }
  } catch {
    // Ignore stale/unreadable PID file.
  }
  try {
    unlinkSync(pidPath);
  } catch {
    // Ignore missing PID file.
  }
  return stopped;
}

export async function serveProxyForeground({ port, token = '' } = {}) {
  const cfg = ensureProxyConfig();
  const targetPort =
    port !== undefined && port !== null && port !== ''
      ? Number(port)
      : Number.isInteger(cfg.port) && cfg.port >= 0
        ? cfg.port
        : DEFAULT_PROXY_PORT;
  const targetToken = token || cfg.token;

  let proxy;
  try {
    proxy = await startAnthropicProxy({
      port: targetPort,
      token: targetToken,
      dynamicSettings: true,
      source: 'global-proxy',
    });
  } catch (err) {
    if (err?.code !== 'EADDRINUSE') throw err;
    let reclaimed = false;
    if (targetPort > 0) {
      const occupier = await probeProxyHealth(`http://127.0.0.1:${targetPort}`, { timeoutMs: 800 });
      if (occupier.running && occupier.pid > 0 && occupier.pid !== process.pid) {
        try {
          process.kill(occupier.pid, 'SIGTERM');
          await new Promise((r) => setTimeout(r, 250));
          reclaimed = true;
        } catch {
          reclaimed = false;
        }
      }
    }
    if (reclaimed) {
      try {
        proxy = await startAnthropicProxy({
          port: targetPort,
          token: targetToken,
          dynamicSettings: true,
          source: 'global-proxy',
        });
      } catch (retryErr) {
        if (retryErr?.code !== 'EADDRINUSE') throw retryErr;
      }
    }
    if (!proxy) {
      proxy = await startAnthropicProxy({
        port: 0,
        token: targetToken,
        dynamicSettings: true,
        source: 'global-proxy',
      });
    }
  }

  writeJsonAtomic(
    getProxyConfigPath(),
    {
      ...cfg,
      port: proxy.port,
      token: proxy.token,
      baseUrl: proxy.baseUrl,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
    },
    0o600
  );

  const pidPath = getProxyPidPath();
  mkdirSync(dirname(pidPath), { recursive: true });
  writeFileSync(pidPath, `${process.pid}\n`, { mode: 0o600 });

  const cleanup = async () => {
    try {
      if (existsSync(pidPath) && Number(readFileSync(pidPath, 'utf-8').trim()) === process.pid) {
        unlinkSync(pidPath);
      }
    } catch {
      // Ignore cleanup failures.
    }
    await proxy.close();
  };

  return { proxy, cleanup };
}

async function waitForHealth(getBaseUrl, timeoutMs = 4500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = typeof getBaseUrl === 'function' ? getBaseUrl() : getBaseUrl;
    if (url) {
      const health = await probeProxyHealth(url, { timeoutMs: 800 });
      if (health.running) return health;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return { running: false, error: 'Proxy did not respond on /health in time' };
}

function tryLaunchdStart({ plistPath, nodeBin, proxyScriptPath, logPath }) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : '';
  if (uid === '') return false;

  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  const plist = buildLaunchAgentPlist({
    nodeBin,
    proxyScriptPath,
    logPath,
    envVars: buildDaemonEnvVars(),
  });
  writeFileSync(plistPath, plist, { mode: 0o644 });

  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}/${LAUNCH_AGENT_LABEL}`], {
      stdio: 'ignore',
      timeout: 3000,
    });
  } catch {
    // Not previously loaded.
  }

  try {
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], {
      stdio: 'pipe',
      timeout: 8000,
    });
    return true;
  } catch {
    try {
      execFileSync('launchctl', ['load', '-w', plistPath], {
        stdio: 'pipe',
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }
}

function stopLaunchdAgent(plistPath) {
  if (process.platform !== 'darwin') return false;
  let didUnload = false;
  const uid = typeof process.getuid === 'function' ? process.getuid() : '';
  if (uid !== '') {
    try {
      execFileSync('launchctl', ['bootout', `gui/${uid}/${LAUNCH_AGENT_LABEL}`], {
        stdio: 'ignore',
        timeout: 3000,
      });
      didUnload = true;
    } catch {
      // Try legacy unload when plist exists.
    }
  }
  if (existsSync(plistPath)) {
    try {
      execFileSync('launchctl', ['unload', '-w', plistPath], {
        stdio: 'ignore',
        timeout: 3000,
      });
      didUnload = true;
    } catch {
      // Ignore if already unloaded.
    }
    try {
      unlinkSync(plistPath);
      didUnload = true;
    } catch {
      // Ignore unlink error.
    }
  }
  return didUnload;
}

function trySystemdStart({ unitPath, nodeBin, proxyScriptPath, logPath }) {
  try {
    mkdirSync(dirname(unitPath), { recursive: true });
    mkdirSync(dirname(logPath), { recursive: true });
    const unitText = buildSystemdServiceUnit({
      nodeBin,
      proxyScriptPath,
      logPath,
      envVars: buildDaemonEnvVars(),
    });
    writeFileSync(unitPath, unitText, { mode: 0o644 });
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe', timeout: 5000 });
    execFileSync('systemctl', ['--user', 'enable', '--now', SYSTEMD_SERVICE_NAME], {
      stdio: 'pipe',
      timeout: 8000,
    });
    return true;
  } catch {
    return false;
  }
}

function stopSystemdService(unitPath) {
  if (process.platform !== 'linux') return false;
  let stopped = false;
  try {
    execFileSync('systemctl', ['--user', 'disable', '--now', SYSTEMD_SERVICE_NAME], {
      stdio: 'ignore',
      timeout: 5000,
    });
    stopped = true;
  } catch {
    // Ignore when service is not loaded or systemd user bus is unavailable.
  }
  if (existsSync(unitPath)) {
    try {
      unlinkSync(unitPath);
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore', timeout: 3000 });
      stopped = true;
    } catch {
      // Ignore cleanup error.
    }
  }
  return stopped;
}

export async function ensureDaemonRunning({
  homeDir = homedir(),
  useLaunchd = process.platform === 'darwin' && homeDir === homedir(),
  useSystemd = process.platform === 'linux' && homeDir === homedir(),
  preferredPort,
  nodeBin = process.execPath,
  proxyScriptPath = getProxyScriptPath(),
} = {}) {
  const cfg = ensureProxyConfig({ preferredPort });
  if (cfg.baseUrl && cfg.port > 0) {
    const existingHealth = await probeProxyHealth(cfg.baseUrl);
    if (existingHealth.running && existingHealth.dynamicSettings) {
      const mode = existsSync(getLaunchAgentPath(homeDir))
        ? 'launchd'
        : existsSync(getSystemdUnitPath(homeDir))
          ? 'systemd'
          : 'background';
      return {
        ok: true,
        mode,
        alreadyRunning: true,
        config: cfg,
        health: existingHealth,
      };
    }
  }

  // Stop stale non-dynamic/old PID before starting fresh.
  stopProcessFromPidFile();

  const plistPath = getLaunchAgentPath(homeDir);
  const unitPath = getSystemdUnitPath(homeDir);
  const logPath = getProxyLogPath();
  const readLatestBaseUrl = () => {
    const latest = readJsonSafe(getProxyConfigPath(), null);
    return latest?.port > 0 && latest?.baseUrl ? latest.baseUrl : '';
  };

  if (useLaunchd && tryLaunchdStart({ plistPath, nodeBin, proxyScriptPath, logPath })) {
    const health = await waitForHealth(readLatestBaseUrl, 12_000);
    if (health.running) {
      const latestCfg = ensureProxyConfig({ preferredPort });
      return {
        ok: true,
        mode: 'launchd',
        alreadyRunning: false,
        plistPath,
        config: latestCfg,
        health,
      };
    }
    // Unload LaunchAgent cleanly before falling back so launchd never wakes up later and races.
    stopLaunchdAgent(plistPath);
  }

  if (useSystemd && trySystemdStart({ unitPath, nodeBin, proxyScriptPath, logPath })) {
    const health = await waitForHealth(readLatestBaseUrl, 10_000);
    if (health.running) {
      const latestCfg = ensureProxyConfig({ preferredPort });
      return {
        ok: true,
        mode: 'systemd',
        alreadyRunning: false,
        unitPath,
        config: latestCfg,
        health,
      };
    }
    stopSystemdService(unitPath);
  }

  // Fallback to detached Node background daemon (Linux, SSH/headless, or test environments).
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, 'a', 0o600);
  const serveArgs = [proxyScriptPath, 'serve'];
  if (preferredPort !== undefined && preferredPort !== null) {
    serveArgs.push('--port', String(preferredPort));
  }
  const child = spawn(nodeBin, serveArgs, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  });
  child.unref();

  const health = await waitForHealth(readLatestBaseUrl, 5000);
  if (!health.running) {
    throw new Error(`Failed to start local GOAT proxy daemon on ${cfg.baseUrl || 'loopback'}. Check ${logPath}.`);
  }

  const latestCfg = ensureProxyConfig({ preferredPort });
  return {
    ok: true,
    mode: 'detached',
    alreadyRunning: false,
    config: latestCfg,
    health,
  };
}

export async function stopAndRemoveDaemon({
  homeDir = homedir(),
  useLaunchd = process.platform === 'darwin' && homeDir === homedir(),
  useSystemd = process.platform === 'linux' && homeDir === homedir(),
  removeConfig = false,
} = {}) {
  const plistPath = getLaunchAgentPath(homeDir);
  const unitPath = getSystemdUnitPath(homeDir);
  const stoppedLaunchd = useLaunchd ? stopLaunchdAgent(plistPath) : false;
  const stoppedSystemd = useSystemd ? stopSystemdService(unitPath) : false;
  let stoppedPid = stopProcessFromPidFile();

  // Also terminate a stray running proxy recorded in proxy.json or listening on cfg.baseUrl.
  const cfg = readJsonSafe(getProxyConfigPath(), null);
  if (cfg?.baseUrl) {
    const health = await probeProxyHealth(cfg.baseUrl, { timeoutMs: 500 });
    if (health.running && health.pid > 0 && health.pid !== process.pid) {
      try {
        process.kill(health.pid, 'SIGTERM');
        stoppedPid = true;
      } catch {
        // Ignore if already exited.
      }
    }
  }

  if (removeConfig && existsSync(getProxyConfigPath())) {
    try {
      unlinkSync(getProxyConfigPath());
    } catch {
      // Ignore cleanup failures.
    }
  }

  return {
    stoppedLaunchd,
    stoppedSystemd,
    stoppedPid,
    plistPath,
    unitPath,
  };
}

export async function getDaemonStatus({ homeDir = homedir() } = {}) {
  const cfgPath = getProxyConfigPath();
  const cfg = readJsonSafe(cfgPath, null);
  const plistPath = getLaunchAgentPath(homeDir);
  const unitPath = getSystemdUnitPath(homeDir);
  const pidPath = getProxyPidPath();
  const pid = existsSync(pidPath) ? Number(readFileSync(pidPath, 'utf-8').trim()) || 0 : 0;
  const health = cfg?.baseUrl ? await probeProxyHealth(cfg.baseUrl) : { running: false };

  return {
    configured: Boolean(cfg?.baseUrl && cfg?.token),
    baseUrl: cfg?.baseUrl || '',
    port: cfg?.port || 0,
    launchAgentInstalled: existsSync(plistPath),
    plistPath,
    systemdUnitInstalled: existsSync(unitPath),
    unitPath,
    pid: health.pid || (isPidAlive(pid) ? pid : 0),
    running: Boolean(health.running),
    dynamicSettings: Boolean(health.dynamicSettings),
    logPath: getProxyLogPath(),
  };
}
