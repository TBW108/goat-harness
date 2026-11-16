#!/usr/bin/env node
import {
  ensureDaemonRunning,
  getDaemonStatus,
  getProxyLogPath,
  serveProxyForeground,
  stopAndRemoveDaemon,
} from '../lib/proxy-daemon.mjs';
import { runProxyMonitor } from '../lib/proxy-monitor.mjs';
import { isMainModule } from '../lib/store.mjs';

const USAGE = `Usage: goat-proxy <command>

Commands:
  start                    Ensure the persistent local ChatGPT<->Anthropic proxy daemon is running
  stop                     Stop the background proxy daemon (and unload LaunchAgent / systemd)
  restart                  Restart the background proxy daemon with latest environment
  status [--json]          Show daemon status, port, PID, and service path
  monitor [--once] [--json] Live terminal dashboard showing requests, TTFT, cache hits & errors
  serve                    Run the proxy in the foreground (used by LaunchAgent / systemd)
  logs                     Print the proxy log file path
`;

export async function runProxyCli(argv = process.argv.slice(2), deps = {}) {
  const out = deps.stdout || process.stdout;
  const errOut = deps.stderr || process.stderr;
  const cmd = String(argv[0] || 'status').trim();

  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    out.write(USAGE);
    return 0;
  }

  if (cmd === 'serve') {
    const portIdx = argv.indexOf('--port');
    let port;
    if (portIdx >= 0 && argv[portIdx + 1] !== undefined) {
      port = Number(argv[portIdx + 1]);
    } else {
      const eqArg = argv.find((a) => a.startsWith('--port='));
      if (eqArg) port = Number(eqArg.slice(7));
      else if (process.env.GOAT_PROXY_PORT !== undefined && process.env.GOAT_PROXY_PORT !== '') {
        port = Number(process.env.GOAT_PROXY_PORT);
      }
    }
    const { proxy, cleanup } = await serveProxyForeground(
      Number.isFinite(port) ? { port } : {}
    );
    out.write(`GOAT proxy listening on ${proxy.baseUrl} (pid ${process.pid})\n`);
    await new Promise((resolve) => {
      const handleSignal = () => {
        cleanup().finally(resolve);
      };
      process.once('SIGINT', handleSignal);
      process.once('SIGTERM', handleSignal);
    });
    return 0;
  }

  if (cmd === 'start') {
    const res = await ensureDaemonRunning(deps.homeDir ? { homeDir: deps.homeDir } : {});
    out.write(
      `GOAT proxy ${res.alreadyRunning ? 'already running' : 'started'} [${res.mode}] on ${res.config.baseUrl} (pid ${res.health.pid})\n`
    );
    return 0;
  }

  if (cmd === 'stop') {
    await stopAndRemoveDaemon(deps.homeDir ? { homeDir: deps.homeDir } : {});
    out.write('GOAT proxy daemon stopped.\n');
    return 0;
  }

  if (cmd === 'restart') {
    const opts = deps.homeDir ? { homeDir: deps.homeDir } : {};
    await stopAndRemoveDaemon(opts);
    const res = await ensureDaemonRunning(opts);
    out.write(`GOAT proxy restarted [${res.mode}] on ${res.config.baseUrl} (pid ${res.health.pid})\n`);
    return 0;
  }

  if (cmd === 'status') {
    const status = await getDaemonStatus(deps.homeDir ? { homeDir: deps.homeDir } : {});
    if (argv.includes('--json')) {
      out.write(`${JSON.stringify(status, null, 2)}\n`);
    } else {
      out.write(`Proxy Running : ${status.running ? `yes (pid ${status.pid})` : 'no'}\n`);
      out.write(`Listen URL    : ${status.baseUrl || '(not initialized)'}\n`);
      if (process.platform === 'linux') {
        out.write(
          `Systemd Unit  : ${status.systemdUnitInstalled ? `installed (${status.unitPath})` : 'not installed'}\n`
        );
      } else {
        out.write(
          `LaunchAgent   : ${status.launchAgentInstalled ? `installed (${status.plistPath})` : 'not installed'}\n`
        );
      }
      out.write(`Log File      : ${status.logPath}\n`);
    }
    return 0;
  }

  if (cmd === 'monitor' || cmd === 'top') {
    const once = argv.includes('--once');
    const json = argv.includes('--json');
    return await (deps.runProxyMonitor || runProxyMonitor)({
      once,
      json,
      stdout: out,
      stderr: errOut,
      stdin: deps.stdin || process.stdin,
    });
  }

  if (cmd === 'logs') {
    out.write(`${getProxyLogPath()}\n`);
    return 0;
  }

  errOut.write(`Unknown command: ${cmd}\n${USAGE}`);
  return 2;
}

if (isMainModule(import.meta.url)) {
  runProxyCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
