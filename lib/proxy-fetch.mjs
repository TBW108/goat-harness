import { execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import tls from 'node:tls';

const DEFAULT_NO_PROXY_HOSTS = ['127.0.0.1', 'localhost', '::1'];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SYSTEM_PROXY_TTL_MS = 5_000;
let systemProxyCache = { fetchedAt: 0, env: null };

function normalizeHost(host) {
  return String(host || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
}

function shouldBypassProxy(hostname, port, noProxyRaw) {
  const cleanHost = normalizeHost(hostname);
  if (!cleanHost) return true;
  if (!noProxyRaw) return false;

  const entries = String(noProxyRaw)
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);

  for (const entry of entries) {
    if (entry === '*') return true;
    let entryHost = entry;
    let entryPort = '';

    // Handle host:port entries (while preserving bare IPv6 like ::1).
    if (entry.startsWith('[')) {
      const endBracket = entry.indexOf(']');
      if (endBracket !== -1) {
        entryHost = entry.slice(1, endBracket);
        if (entry[endBracket + 1] === ':') {
          entryPort = entry.slice(endBracket + 2);
        }
      }
    } else {
      const firstColon = entry.indexOf(':');
      const lastColon = entry.lastIndexOf(':');
      if (firstColon !== -1 && firstColon === lastColon) {
        entryHost = entry.slice(0, lastColon);
        entryPort = entry.slice(lastColon + 1);
      }
    }

    if (entryPort && String(port) !== entryPort) continue;

    const cleanEntry = normalizeHost(entryHost);
    if (!cleanEntry) continue;
    if (cleanEntry.startsWith('.')) {
      const suffix = cleanEntry.slice(1);
      if (cleanHost === suffix || cleanHost.endsWith(cleanEntry)) return true;
    } else if (cleanHost === cleanEntry || cleanHost.endsWith(`.${cleanEntry}`)) {
      return true;
    }
  }

  return false;
}

/**
 * Resolves the upstream proxy URL for a given HTTP(S) target URL, respecting NO_PROXY / no_proxy.
 * Returns an empty string when direct connection should be used.
 */
export function resolveProxyForUrl(targetUrl, env = process.env) {
  const url = targetUrl instanceof URL ? targetUrl : new URL(String(targetUrl));
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';

  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const noProxy = env.NO_PROXY ?? env.no_proxy ?? '';
  if (shouldBypassProxy(url.hostname, port, noProxy)) return '';

  const raw =
    url.protocol === 'https:'
      ? env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || ''
      : env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || '';

  return String(raw || '').trim();
}

/**
 * Parses `scutil --proxy` output on macOS into standard HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY env keys.
 */
export function parseScutilProxyOutput(rawText) {
  const text = String(rawText || '');
  const kv = new Map();
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (m) kv.set(m[1], m[2]);
  }

  const out = {};
  if (kv.get('HTTPSEnable') === '1' && kv.get('HTTPSProxy') && kv.get('HTTPSPort')) {
    out.HTTPS_PROXY = `http://${kv.get('HTTPSProxy')}:${kv.get('HTTPSPort')}`;
  }
  if (kv.get('HTTPEnable') === '1' && kv.get('HTTPProxy') && kv.get('HTTPPort')) {
    out.HTTP_PROXY = `http://${kv.get('HTTPProxy')}:${kv.get('HTTPPort')}`;
  }
  if (kv.get('SOCKSEnable') === '1' && kv.get('SOCKSProxy') && kv.get('SOCKSPort')) {
    out.ALL_PROXY = `socks5h://${kv.get('SOCKSProxy')}:${kv.get('SOCKSPort')}`;
  }

  const excMatch = /ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}/m.exec(text);
  const exceptions = [...DEFAULT_NO_PROXY_HOSTS];
  const seen = new Set(exceptions);
  if (excMatch) {
    for (const line of excMatch[1].split('\n')) {
      const itemMatch = /^\s*\d+\s*:\s*(.+?)\s*$/.exec(line);
      const val = itemMatch?.[1]?.trim();
      if (!val || val === '<local>' || seen.has(val)) continue;
      seen.add(val);
      exceptions.push(val);
    }
  }
  out.NO_PROXY = exceptions.join(',');
  return out;
}

function readMacSystemProxyEnv() {
  if (process.platform !== 'darwin' || process.env.GOAT_DISABLE_SYSTEM_PROXY === '1') {
    return {};
  }
  if (systemProxyCache.env && Date.now() - systemProxyCache.fetchedAt < SYSTEM_PROXY_TTL_MS) {
    return systemProxyCache.env;
  }
  try {
    const raw = execFileSync('scutil', ['--proxy'], { encoding: 'utf-8', timeout: 800 });
    const parsed = parseScutilProxyOutput(raw);
    systemProxyCache = { fetchedAt: Date.now(), env: parsed };
    return parsed;
  } catch {
    systemProxyCache = { fetchedAt: Date.now(), env: {} };
    return {};
  }
}

function hasAnyEnvProxy(env) {
  return Boolean(
    env.HTTPS_PROXY ||
      env.https_proxy ||
      env.HTTP_PROXY ||
      env.http_proxy ||
      env.ALL_PROXY ||
      env.all_proxy
  );
}

function resolveEffectiveProxyForUrl(targetUrl, env = process.env) {
  const explicit = resolveProxyForUrl(targetUrl, env);
  if (explicit || hasAnyEnvProxy(env)) return explicit;
  // Background daemons (LaunchAgent) run without shell rc exports; fall back to macOS System Proxy.
  const sysEnv = readMacSystemProxyEnv();
  return hasAnyEnvProxy(sysEnv) ? resolveProxyForUrl(targetUrl, sysEnv) : '';
}

/**
 * Ensures NO_PROXY and no_proxy always include local loopback addresses so local
 * subprocesses (like Claude Code calling our loopback proxy) never loop through HTTP_PROXY.
 */
export function ensureLoopbackNoProxy(env = {}) {
  const existing = String(env.NO_PROXY || env.no_proxy || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set(existing.map((s) => normalizeHost(s)));
  const merged = [...existing];
  for (const host of DEFAULT_NO_PROXY_HOSTS) {
    if (!seen.has(host)) {
      merged.push(host);
      seen.add(host);
    }
  }
  const value = merged.join(',');
  return {
    ...env,
    NO_PROXY: value,
    no_proxy: value,
  };
}

function makeAbortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  if (signal?.reason) return new Error(String(signal.reason));
  return new DOMException('The operation was aborted', 'AbortError');
}

function proxyAuthHeader(proxyUrl) {
  if (!proxyUrl.username && !proxyUrl.password) return null;
  const user = decodeURIComponent(proxyUrl.username || '');
  const pass = decodeURIComponent(proxyUrl.password || '');
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function openHttpConnectTunnel(proxyUrl, targetHost, targetPort, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError(signal));
      return;
    }

    const isTlsProxy = proxyUrl.protocol === 'https:';
    const proxyPort = Number(proxyUrl.port) || (isTlsProxy ? 443 : 80);
    const authority = `${targetHost.includes(':') ? `[${targetHost}]` : targetHost}:${targetPort}`;
    const headers = { Host: authority };
    const auth = proxyAuthHeader(proxyUrl);
    if (auth) headers['Proxy-Authorization'] = auth;

    const req = (isTlsProxy ? https : http).request({
      hostname: proxyUrl.hostname.replace(/^\[|\]$/g, ''),
      port: proxyPort,
      method: 'CONNECT',
      path: authority,
      headers,
    });

    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const err = makeAbortError(signal);
      req.destroy(err);
      reject(err);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    req.once('connect', (res, socket, head) => {
      if (settled) {
        socket.destroy();
        return;
      }
      settled = true;
      cleanup();
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed with HTTP ${res.statusCode}`));
        return;
      }
      if (head && head.length) {
        socket.unshift(head);
      }
      resolve(socket);
    });

    req.once('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    req.end();
  });
}

function encodeSocks5Target(targetHost, targetPort) {
  const cleanHost = targetHost.replace(/^\[|\]$/g, '');
  const ipVer = net.isIP(cleanHost);
  const portBuf = Buffer.allocUnsafe(2);
  portBuf.writeUInt16BE(Number(targetPort), 0);

  if (ipVer === 4) {
    const octets = cleanHost.split('.').map((n) => Number(n));
    return Buffer.concat([Buffer.from([0x01, ...octets]), portBuf]);
  }
  if (ipVer === 6) {
    const groups = cleanHost.split(':');
    const addrBuf = Buffer.alloc(16);
    const emptyIdx = groups.indexOf('');
    let expanded = [];
    if (emptyIdx !== -1) {
      const before = groups.slice(0, emptyIdx).filter(Boolean);
      const after = groups.slice(emptyIdx + 1).filter(Boolean);
      const missing = Math.max(0, 8 - before.length - after.length);
      expanded = [...before, ...Array(missing).fill('0'), ...after];
    } else {
      expanded = groups;
    }
    for (let i = 0; i < 8; i += 1) {
      addrBuf.writeUInt16BE(parseInt(expanded[i] || '0', 16), i * 2);
    }
    return Buffer.concat([Buffer.from([0x04]), addrBuf, portBuf]);
  }

  const hostBuf = Buffer.from(cleanHost, 'utf8');
  return Buffer.concat([Buffer.from([0x03, hostBuf.length]), hostBuf, portBuf]);
}

function openSocks5Tunnel(proxyUrl, targetHost, targetPort, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError(signal));
      return;
    }

    const proxyPort = Number(proxyUrl.port) || 1080;
    const hasAuth = Boolean(proxyUrl.username || proxyUrl.password);
    const socket = net.connect({
      host: proxyUrl.hostname.replace(/^\[|\]$/g, ''),
      port: proxyPort,
    });

    let settled = false;
    let stage = 'greeting';
    let buf = Buffer.alloc(0);

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    };

    const onAbort = () => fail(makeAbortError(signal));
    const onError = (err) => fail(err);
    const onClose = () => fail(new Error('SOCKS5 proxy closed connection during handshake'));

    signal?.addEventListener('abort', onAbort, { once: true });
    socket.on('error', onError);
    socket.on('close', onClose);

    const sendConnectRequest = () => {
      stage = 'connect';
      const addrPart = encodeSocks5Target(targetHost, targetPort);
      socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addrPart]));
    };

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        while (buf.length > 0 && !settled) {
          if (stage === 'greeting') {
            if (buf.length < 2) return;
            const ver = buf[0];
            const method = buf[1];
            buf = buf.subarray(2);
            if (ver !== 0x05 || method === 0xff) {
              fail(new Error('SOCKS5 proxy rejected authentication methods'));
              return;
            }
            if (method === 0x02) {
              if (!hasAuth) {
                fail(new Error('SOCKS5 proxy requires username/password'));
                return;
              }
              stage = 'auth';
              const u = Buffer.from(decodeURIComponent(proxyUrl.username || ''), 'utf8');
              const p = Buffer.from(decodeURIComponent(proxyUrl.password || ''), 'utf8');
              socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
            } else if (method === 0x00) {
              sendConnectRequest();
            } else {
              fail(new Error(`Unsupported SOCKS5 auth method: ${method}`));
              return;
            }
          } else if (stage === 'auth') {
            if (buf.length < 2) return;
            const status = buf[1];
            buf = buf.subarray(2);
            if (status !== 0x00) {
              fail(new Error('SOCKS5 username/password authentication failed'));
              return;
            }
            sendConnectRequest();
          } else if (stage === 'connect') {
            if (buf.length < 4) return;
            const rep = buf[1];
            const atyp = buf[3];
            let needed = 4;
            if (atyp === 0x01) needed = 4 + 4 + 2;
            else if (atyp === 0x04) needed = 4 + 16 + 2;
            else if (atyp === 0x03) {
              if (buf.length < 5) return;
              needed = 4 + 1 + buf[4] + 2;
            } else {
              fail(new Error(`Unsupported SOCKS5 ATYP: ${atyp}`));
              return;
            }
            if (buf.length < needed) return;
            const remaining = buf.subarray(needed);
            if (rep !== 0x00) {
              fail(new Error(`SOCKS5 CONNECT failed with reply code ${rep}`));
              return;
            }
            settled = true;
            cleanup();
            if (remaining.length) {
              socket.unshift(remaining);
            }
            resolve(socket);
            return;
          }
        }
      } catch (err) {
        fail(err);
      }
    };

    socket.on('data', onData);
    socket.once('connect', () => {
      const methods = hasAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00];
      socket.write(Buffer.from(methods));
    });
  });
}

async function normalizeBody(rawBody, headers) {
  if (rawBody === undefined || rawBody === null) return null;
  if (rawBody instanceof URLSearchParams) {
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
    }
    return Buffer.from(rawBody.toString(), 'utf8');
  }
  if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (rawBody instanceof Uint8Array) return Buffer.from(rawBody);
  if (rawBody instanceof ArrayBuffer) return Buffer.from(rawBody);
  return Buffer.from(String(rawBody), 'utf8');
}

function toNodeHeaders(webHeaders) {
  const out = {};
  for (const [k, v] of webHeaders.entries()) {
    out[k] = v;
  }
  return out;
}

function toWebHeaders(nodeHeaders) {
  const headers = new Headers();
  for (const [key, val] of Object.entries(nodeHeaders || {})) {
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      for (const item of val) headers.append(key, String(item));
    } else {
      headers.set(key, String(val));
    }
  }
  return headers;
}

async function sendViaProxy({ targetUrl, proxyUrl, method, headers, bodyBuffer, signal }) {
  const targetHost = targetUrl.hostname.replace(/^\[|\]$/g, '');
  const isHttpsTarget = targetUrl.protocol === 'https:';
  const targetPort = Number(targetUrl.port) || (isHttpsTarget ? 443 : 80);
  const proxyScheme = proxyUrl.protocol.toLowerCase();

  let transport = isHttpsTarget ? https : http;
  let reqOptions;

  try {
    if (proxyScheme === 'socks:' || proxyScheme === 'socks5:' || proxyScheme === 'socks5h:') {
      const rawSocket = await openSocks5Tunnel(proxyUrl, targetHost, targetPort, signal);
      const nodeHeaders = toNodeHeaders(headers);
      if (!nodeHeaders.connection && !nodeHeaders.Connection) {
        nodeHeaders.Connection = 'close';
      }
      reqOptions = {
        hostname: targetHost,
        port: targetPort,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method,
        headers: nodeHeaders,
        createConnection: () =>
          isHttpsTarget ? tls.connect({ socket: rawSocket, servername: targetHost }) : rawSocket,
      };
    } else if (proxyScheme === 'http:' || proxyScheme === 'https:') {
      if (isHttpsTarget) {
        const tunnelSocket = await openHttpConnectTunnel(proxyUrl, targetHost, targetPort, signal);
        const nodeHeaders = toNodeHeaders(headers);
        if (!nodeHeaders.connection && !nodeHeaders.Connection) {
          nodeHeaders.Connection = 'close';
        }
        reqOptions = {
          hostname: targetHost,
          port: targetPort,
          path: `${targetUrl.pathname}${targetUrl.search}`,
          method,
          headers: nodeHeaders,
          createConnection: () => tls.connect({ socket: tunnelSocket, servername: targetHost }),
        };
      } else {
        const isTlsProxy = proxyScheme === 'https:';
        transport = isTlsProxy ? https : http;
        const nodeHeaders = toNodeHeaders(headers);
        if (!nodeHeaders.host && !nodeHeaders.Host) {
          nodeHeaders.Host = targetUrl.host;
        }
        const auth = proxyAuthHeader(proxyUrl);
        if (auth) nodeHeaders['Proxy-Authorization'] = auth;
        reqOptions = {
          hostname: proxyUrl.hostname.replace(/^\[|\]$/g, ''),
          port: Number(proxyUrl.port) || (isTlsProxy ? 443 : 80),
          path: targetUrl.toString(),
          method,
          headers: nodeHeaders,
          agent: false,
        };
      }
    } else {
      throw new Error(`Unsupported proxy protocol: ${proxyUrl.protocol}`);
    }
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) throw err;
    throw new TypeError('fetch failed', { cause: err });
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError(signal));
      return;
    }

    const nodeReq = transport.request(reqOptions);
    let settled = false;

    const onAbort = () => {
      const err = makeAbortError(signal);
      nodeReq.destroy(err);
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    nodeReq.once('response', (nodeRes) => {
      if (settled) return;
      settled = true;

      const detachAbort = () => {
        signal?.removeEventListener('abort', onAbort);
      };
      nodeRes.once('end', detachAbort);
      nodeRes.once('close', detachAbort);
      nodeRes.once('error', detachAbort);

      const status = nodeRes.statusCode || 200;
      const noBody = [101, 204, 205, 304].includes(status) || method.toUpperCase() === 'HEAD';
      const bodyStream = noBody ? null : Readable.toWeb(nodeRes);

      resolve(
        new Response(bodyStream, {
          status,
          statusText: nodeRes.statusMessage || '',
          headers: toWebHeaders(nodeRes.headers),
        })
      );
    });

    nodeReq.once('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      if (err?.name === 'AbortError' || signal?.aborted) {
        reject(err);
      } else {
        reject(new TypeError('fetch failed', { cause: err }));
      }
    });

    if (bodyBuffer && bodyBuffer.length) {
      nodeReq.write(bodyBuffer);
    }
    nodeReq.end();
  });
}

/**
 * Drop-in `fetch` wrapper that automatically honors HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
 * (and NO_PROXY) even when NODE_USE_ENV_PROXY is unset, while preserving Web ReadableStream
 * responses for SSE streaming and delegating unproxied / loopback calls directly to native `fetch`.
 */
export async function proxyFetch(input, init = {}) {
  const signal = init.signal ?? (typeof Request !== 'undefined' && input instanceof Request ? input.signal : undefined);
  if (signal?.aborted) {
    throw makeAbortError(signal);
  }

  const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const proxyStr = resolveEffectiveProxyForUrl(rawUrl, process.env);
  if (!proxyStr) {
    return fetch(input, init);
  }

  let currentUrl = new URL(rawUrl);
  let method = (init.method || (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase();
  const headers = new Headers(
    init.headers || (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined)
  );
  const bodyBuffer = await normalizeBody(init.body, headers);

  for (let hop = 0; hop <= 5; hop += 1) {
    const hopProxyStr = resolveEffectiveProxyForUrl(currentUrl, process.env);
    if (!hopProxyStr) {
      return fetch(currentUrl.toString(), { ...init, method, headers, body: hop === 0 ? init.body : bodyBuffer });
    }

    let proxyUrl;
    try {
      proxyUrl = new URL(hopProxyStr);
    } catch {
      return fetch(input, init);
    }

    const res = await sendViaProxy({
      targetUrl: currentUrl,
      proxyUrl,
      method,
      headers,
      bodyBuffer: hop === 0 ? bodyBuffer : null,
      signal,
    });

    if (init.redirect !== 'manual' && REDIRECT_STATUSES.has(res.status)) {
      const loc = res.headers.get('location');
      if (loc) {
        await res.body?.cancel?.().catch(() => {});
        currentUrl = new URL(loc, currentUrl);
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          method = 'GET';
        }
        continue;
      }
    }

    return res;
  }

  throw new TypeError('fetch failed', { cause: new Error('Too many redirects') });
}
