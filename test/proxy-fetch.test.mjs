import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import {
  ensureLoopbackNoProxy,
  parseScutilProxyOutput,
  proxyFetch,
  resolveProxyForUrl,
} from '../lib/proxy-fetch.mjs';

test('resolveProxyForUrl respects HTTPS_PROXY, HTTP_PROXY, ALL_PROXY, and NO_PROXY', () => {
  const env = {
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    HTTP_PROXY: 'http://127.0.0.1:7891',
    ALL_PROXY: 'socks5h://127.0.0.1:7892',
    NO_PROXY: 'localhost,127.0.0.1,.internal.local',
  };

  assert.equal(resolveProxyForUrl('https://api.openai.com/v1/models', env), 'http://127.0.0.1:7890');
  assert.equal(resolveProxyForUrl('http://api.example.com/test', env), 'http://127.0.0.1:7891');
  assert.equal(resolveProxyForUrl('http://127.0.0.1:4000/v1/messages', env), '');
  assert.equal(resolveProxyForUrl('http://localhost:3000/', env), '');
  assert.equal(resolveProxyForUrl('https://svc.internal.local/api', env), '');

  const socksOnlyEnv = { ALL_PROXY: 'socks5h://127.0.0.1:1080', no_proxy: 'localhost' };
  assert.equal(resolveProxyForUrl('https://api.openai.com/v1/responses', socksOnlyEnv), 'socks5h://127.0.0.1:1080');
});

test('ensureLoopbackNoProxy merges loopback hosts without duplicates', () => {
  const updated = ensureLoopbackNoProxy({ NO_PROXY: 'example.com, 127.0.0.1' });
  assert.equal(updated.NO_PROXY, 'example.com,127.0.0.1,localhost,::1');
  assert.equal(updated.no_proxy, 'example.com,127.0.0.1,localhost,::1');
});

test('proxyFetch routes HTTP requests through HTTP_PROXY and streams SSE', async () => {
  const savedEnv = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    ALL_PROXY: process.env.ALL_PROXY,
    NO_PROXY: process.env.NO_PROXY,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    all_proxy: process.env.all_proxy,
    no_proxy: process.env.no_proxy,
  };

  let proxiedTargetUrl = '';
  let proxyAuth = '';
  const proxyServer = http.createServer((req, res) => {
    proxiedTargetUrl = req.url || '';
    proxyAuth = req.headers['proxy-authorization'] || '';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: delta\ndata: {"ok":true}\n\n');
    res.end('data: [DONE]\n\n');
  });

  await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
  const port = proxyServer.address().port;

  try {
    process.env.HTTP_PROXY = `http://user:pass@127.0.0.1:${port}`;
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.all_proxy;
    process.env.NO_PROXY = '';
    process.env.no_proxy = '';

    const res = await proxyFetch('http://api.openai.test/v1/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });

    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /"ok":true/);
    assert.equal(proxiedTargetUrl, 'http://api.openai.test/v1/stream');
    assert.equal(proxyAuth, `Basic ${Buffer.from('user:pass').toString('base64')}`);
  } finally {
    proxyServer.closeAllConnections?.();
    proxyServer.close();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('proxyFetch routes HTTP requests through SOCKS5 ALL_PROXY', async () => {
  const savedEnv = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    ALL_PROXY: process.env.ALL_PROXY,
    NO_PROXY: process.env.NO_PROXY,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    all_proxy: process.env.all_proxy,
    no_proxy: process.env.no_proxy,
  };

  let requestedDomain = '';
  let targetReqPath = '';
  const targetServer = http.createServer((req, res) => {
    targetReqPath = req.url || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ via: 'socks5' }));
  });
  await new Promise((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
  const targetPort = targetServer.address().port;

  const socksServer = net.createServer((client) => {
    let stage = 'greeting';
    let upstream = null;
    client.on('data', (chunk) => {
      if (stage === 'greeting') {
        stage = 'request';
        client.write(Buffer.from([0x05, 0x00]));
      } else if (stage === 'request') {
        assert.equal(chunk[0], 0x05);
        assert.equal(chunk[1], 0x01);
        assert.equal(chunk[3], 0x03);
        const len = chunk[4];
        requestedDomain = chunk.subarray(5, 5 + len).toString('utf8');
        stage = 'piping';
        upstream = net.connect(targetPort, '127.0.0.1', () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 80]));
          const leftover = chunk.subarray(5 + len + 2);
          if (leftover.length) upstream.write(leftover);
        });
        upstream.on('data', (d) => client.write(d));
        upstream.on('end', () => client.end());
        upstream.on('error', () => client.destroy());
      } else if (upstream) {
        upstream.write(chunk);
      }
    });
    client.on('end', () => upstream?.end());
    client.on('error', () => upstream?.destroy());
  });
  await new Promise((resolve) => socksServer.listen(0, '127.0.0.1', resolve));
  const socksPort = socksServer.address().port;

  try {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    process.env.ALL_PROXY = `socks5h://127.0.0.1:${socksPort}`;
    process.env.NO_PROXY = '';
    process.env.no_proxy = '';

    const res = await proxyFetch('http://models.openai.test/v1/models');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data, { via: 'socks5' });
    assert.equal(requestedDomain, 'models.openai.test');
    assert.equal(targetReqPath, '/v1/models');
  } finally {
    socksServer.closeAllConnections?.();
    targetServer.closeAllConnections?.();
    socksServer.close();
    targetServer.close();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('proxyFetch sends HTTP CONNECT for HTTPS_PROXY and wraps proxy errors with cause', async () => {
  const savedEnv = {
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    https_proxy: process.env.https_proxy,
    NO_PROXY: process.env.NO_PROXY,
    no_proxy: process.env.no_proxy,
  };

  let connectTarget = '';
  let proxyAuth = '';
  const connectProxy = http.createServer();
  connectProxy.on('connect', (req, clientSocket) => {
    connectTarget = req.url || '';
    proxyAuth = req.headers['proxy-authorization'] || '';
    clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    clientSocket.destroy();
  });
  await new Promise((resolve) => connectProxy.listen(0, '127.0.0.1', resolve));
  const port = connectProxy.address().port;

  try {
    process.env.HTTPS_PROXY = `http://alice:secret@127.0.0.1:${port}`;
    process.env.NO_PROXY = '';
    process.env.no_proxy = '';

    await assert.rejects(
      () => proxyFetch('https://api.openai.com/v1/models'),
      (err) => {
        assert.equal(err.name, 'TypeError');
        assert.equal(err.message, 'fetch failed');
        assert.match(err.cause?.message || '', /CONNECT failed with HTTP 403/);
        return true;
      }
    );
    assert.equal(connectTarget, 'api.openai.com:443');
    assert.equal(proxyAuth, `Basic ${Buffer.from('alice:secret').toString('base64')}`);
  } finally {
    connectProxy.close();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('parseScutilProxyOutput parses macOS scutil proxy output and exceptions list', () => {
  const sample = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
    2 : 127.0.0.1
    3 : <local>
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7891
  SOCKSProxy : 127.0.0.1
}`;
  const parsed = parseScutilProxyOutput(sample);
  assert.equal(parsed.HTTP_PROXY, 'http://127.0.0.1:7890');
  assert.equal(parsed.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(parsed.ALL_PROXY, 'socks5h://127.0.0.1:7891');
  assert.equal(parsed.NO_PROXY, '127.0.0.1,localhost,::1,*.local,169.254/16');

  const disabled = parseScutilProxyOutput('HTTPEnable : 0\nHTTPSEnable : 0\nSOCKSEnable : 0\n');
  assert.equal(disabled.HTTP_PROXY, undefined);
  assert.equal(disabled.HTTPS_PROXY, undefined);
  assert.equal(disabled.ALL_PROXY, undefined);
  assert.equal(disabled.NO_PROXY, '127.0.0.1,localhost,::1');
});
