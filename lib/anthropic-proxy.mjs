import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { fetchOpenAIModels, getValidOpenAIToken, selectModelTiers } from './openai-oauth.mjs';
import {
  buildResponsesPayload,
  callOpenAIResponsesStream,
  formatAnthropicSse,
  parseSseStream,
  ResponsesToAnthropicConverter,
} from './openai-responses.mjs';
import { proxyFetch } from './proxy-fetch.mjs';
import { getSettings, recordQuotaEvent, recordUsageEvent } from './store.mjs';

function readJsonBody(req, maxBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body exceeded maximum size'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error(`Invalid JSON request body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendAnthropicError(res, status, type, message) {
  sendJson(res, status, {
    type: 'error',
    error: { type, message },
  });
}

function estimateNodeChars(node, key = '') {
  if (node == null) return 4;
  if (typeof node === 'string') {
    const isMediaBlob =
      node.length > 512 &&
      (key === 'data' || key === 'file_data' || key === 'image_url' || node.startsWith('data:'));
    if (isMediaBlob) {
      return Math.min(16_000, Math.max(2000, Math.ceil(node.length / 100)));
    }
    return node.length + 2;
  }
  if (typeof node === 'number' || typeof node === 'boolean') return 6;
  if (Array.isArray(node)) {
    let sum = 2;
    for (const item of node) sum += estimateNodeChars(item) + 1;
    return sum;
  }
  if (typeof node === 'object') {
    let sum = 2;
    for (const [k, v] of Object.entries(node)) {
      sum += k.length + 4 + estimateNodeChars(v, k);
    }
    return sum;
  }
  return 4;
}

function estimateTokenCount(body) {
  try {
    const chars =
      estimateNodeChars(body?.system || '', 'system') +
      estimateNodeChars(body?.messages || [], 'messages') +
      estimateNodeChars(body?.tools || [], 'tools');
    return Math.max(1, Math.ceil(chars / 4));
  } catch {
    return 100;
  }
}

function mapUpstreamErrorToAnthropic(err) {
  const status = Number(err?.status || 0);
  const rawMessage = String(err?.upstreamMessage || (err instanceof Error ? err.message : err) || 'Upstream error');
  const code = String(err?.upstreamCode || '').toLowerCase();
  const lowered = rawMessage.toLowerCase();

  const isContextOverflow =
    status === 413 ||
    code === 'context_length_exceeded' ||
    /context[_\s-]?length|maximum context|too many tokens|prompt is too long|input exceeds/i.test(rawMessage);
  if (isContextOverflow) {
    const msg = lowered.startsWith('prompt is too long') ? rawMessage : `prompt is too long: ${rawMessage}`;
    return { status: 400, type: 'invalid_request_error', message: msg };
  }
  if (status === 400) return { status: 400, type: 'invalid_request_error', message: rawMessage };
  if (status === 401 || rawMessage.includes('Not signed in')) {
    return { status: 401, type: 'authentication_error', message: rawMessage };
  }
  if (status === 403) return { status: 403, type: 'permission_error', message: rawMessage };
  if (status === 404) return { status: 404, type: 'not_found_error', message: rawMessage };
  if (status === 429) return { status: 429, type: 'rate_limit_error', message: rawMessage };
  if (status >= 500) return { status: 502, type: 'api_error', message: rawMessage };
  return { status: 500, type: 'api_error', message: rawMessage };
}

function checkLocalAuth(req, expectedToken) {
  if (!expectedToken) return true;
  const xApiKey = req.headers['x-api-key'];
  if (xApiKey === expectedToken) return true;
  const authHeader = String(req.headers.authorization || '');
  if (authHeader.startsWith('Bearer ') && authHeader.slice(7).trim() === expectedToken) {
    return true;
  }
  return false;
}

function createProxyTelemetry({ getPort, dynamicSettings }) {
  const startedAt = Date.now();
  const MAX_RECENT = 100;
  let seq = 0;
  const active = new Map();
  const recent = [];
  const sseClients = new Set();
  const stats = {
    totalRequests: 0,
    activeRequests: 0,
    completedRequests: 0,
    errorRequests: 0,
    abortedRequests: 0,
    fallbackRecoveredRequests: 0,
    webSearchCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTtftMs: 0,
    ttftCount: 0,
  };

  const snapshot = () => ({
    ok: true,
    pid: process.pid,
    port: getPort(),
    dynamicSettings: Boolean(dynamicSettings),
    startedAt,
    uptimeMs: Date.now() - startedAt,
    stats: {
      ...stats,
      avgTtftMs: stats.ttftCount > 0 ? Math.round(stats.totalTtftMs / stats.ttftCount) : 0,
      cacheHitPct: stats.inputTokens > 0 ? Math.round((stats.cachedTokens / stats.inputTokens) * 100) : 0,
    },
    active: Array.from(active.values()),
    recent: [...recent],
  });

  const broadcast = (eventName, payload) => {
    if (!sseClients.size) return;
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const clientRes of Array.from(sseClients)) {
      if (clientRes.writableEnded || clientRes.destroyed) {
        sseClients.delete(clientRes);
        continue;
      }
      try {
        clientRes.write(frame);
      } catch {
        sseClients.delete(clientRes);
      }
    }
  };

  const beginRequest = ({ requestedModel, targetModel, effort, stream, fastTier = false }) => {
    const entry = {
      id: `req_${++seq}`,
      seq,
      startedAt: Date.now(),
      requestedModel: String(requestedModel || ''),
      targetModel: String(targetModel || ''),
      effort: String(effort || ''),
      fastTier: Boolean(fastTier),
      stream: Boolean(stream),
      status: 'upstream',
      ttftMs: null,
      latencyMs: null,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      toolCalls: 0,
      webSearchCalls: 0,
      fallbackCount: 0,
      error: '',
      finalized: false,
    };
    stats.totalRequests += 1;
    stats.activeRequests += 1;
    active.set(entry.id, entry);
    broadcast('snapshot', snapshot());
    return entry;
  };

  const markFirstToken = (entry) => {
    if (!entry || entry.finalized || entry.ttftMs !== null) return;
    entry.ttftMs = Math.max(0, Date.now() - entry.startedAt);
    entry.status = 'streaming';
    stats.totalTtftMs += entry.ttftMs;
    stats.ttftCount += 1;
    broadcast('snapshot', snapshot());
  };

  const finishRequest = (entry, { status = 'completed', usageDetails = null, toolCalls = 0, webSearchCalls = 0, error = '' } = {}) => {
    if (!entry || entry.finalized) return;
    entry.finalized = true;
    entry.status = status;
    entry.latencyMs = Math.max(0, Date.now() - entry.startedAt);
    entry.error = error ? String(error) : '';
    entry.toolCalls = Number(toolCalls) || 0;
    entry.webSearchCalls = Number(webSearchCalls) || 0;

    if (usageDetails) {
      entry.inputTokens = Number(usageDetails.inputTokens) || 0;
      entry.cachedTokens = Number(usageDetails.cachedTokens) || 0;
      entry.outputTokens = Number(usageDetails.outputTokens) || 0;
      entry.reasoningTokens = Number(usageDetails.reasoningTokens) || 0;
    }

    active.delete(entry.id);
    stats.activeRequests = active.size;
    if (status === 'completed') {
      stats.completedRequests += 1;
      if (entry.fallbackCount > 0) stats.fallbackRecoveredRequests += 1;
    } else if (status === 'aborted') {
      stats.abortedRequests += 1;
    } else {
      stats.errorRequests += 1;
    }

    stats.toolCalls += entry.toolCalls;
    stats.webSearchCalls += entry.webSearchCalls;
    stats.inputTokens += entry.inputTokens;
    stats.cachedTokens += entry.cachedTokens;
    stats.outputTokens += entry.outputTokens;
    stats.reasoningTokens += entry.reasoningTokens;

    recent.unshift({ ...entry });
    if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
    broadcast('snapshot', snapshot());
  };

  const attachSseClient = (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    sseClients.add(res);
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    const keepalive = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) {
        res.write('event: ping\ndata: {"type":"ping"}\n\n');
      }
    }, 10_000);
    keepalive.unref?.();
    req.on('close', () => {
      clearInterval(keepalive);
      sseClients.delete(res);
    });
  };

  const closeAll = () => {
    for (const clientRes of Array.from(sseClients)) {
      if (!clientRes.writableEnded) {
        try {
          clientRes.end();
        } catch {
          // Ignore close errors.
        }
      }
    }
    sseClients.clear();
  };

  return { snapshot, beginRequest, markFirstToken, finishRequest, attachSseClient, closeAll };
}

/**
 * Starts a local loopback Anthropic-compatible HTTP proxy backed by OpenAI /v1/responses.
 */
export async function startAnthropicProxy({
  defaultModel = '',
  modelTiers = null,
  models: providedModels = null,
  reasoningEffort = '',
  source = 'anthropic-proxy',
  port = 0,
  token = '',
  dynamicSettings = false,
  requireAuth = true,
  getTokenFn = getValidOpenAIToken,
  getModelsFn = null,
  fetchImpl = proxyFetch,
  onUsageFn = recordUsageEvent,
  onQuotaErrorFn = recordQuotaEvent,
} = {}) {
  const resolveModelsFn = getModelsFn || fetchOpenAIModels;
  const proxyToken = requireAuth ? String(token || '').trim() || randomBytes(24).toString('hex') : '';
  let server;
  const telemetry = createProxyTelemetry({
    getPort: () => {
      const bound = server?.address?.();
      return bound && typeof bound === 'object' ? bound.port : Number(port) || 0;
    },
    dynamicSettings,
  });

  server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const path = reqUrl.pathname;

    try {
      if (req.method === 'GET' && path === '/health') {
        const snap = telemetry.snapshot();
        sendJson(res, 200, {
          ok: true,
          pid: snap.pid,
          port: snap.port,
          dynamicSettings: snap.dynamicSettings,
          activeRequests: snap.stats.activeRequests,
          totalRequests: snap.stats.totalRequests,
        });
        return;
      }

      if (!checkLocalAuth(req, proxyToken)) {
        sendAnthropicError(res, 401, 'authentication_error', 'Invalid local proxy token.');
        return;
      }

      if (req.method === 'GET' && path === '/_goat/snapshot') {
        sendJson(res, 200, telemetry.snapshot());
        return;
      }

      if (req.method === 'GET' && path === '/_goat/events') {
        telemetry.attachSseClient(req, res);
        return;
      }

      if (req.method === 'GET' && path === '/v1/models') {
        const { models } = await resolveModelsFn({ fetchImpl });
        sendJson(res, 200, {
          data: models.map((m) => ({
            id: m.slug,
            display_name: m.displayName,
            type: 'model',
          })),
          has_more: false,
        });
        return;
      }

      if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
        const body = await readJsonBody(req);
        sendJson(res, 200, { input_tokens: estimateTokenCount(body) });
        return;
      }

      if (req.method === 'POST' && path === '/v1/messages') {
        const startedAt = Date.now();
        const body = await readJsonBody(req);
        const settings = getSettings();
        const effectiveDefaultModel = dynamicSettings
          ? settings.defaultModel || defaultModel
          : defaultModel || settings.defaultModel;
        const effectiveEffort = dynamicSettings
          ? settings.reasoningEffort || reasoningEffort
          : reasoningEffort || settings.reasoningEffort;

        const { token: upstreamToken } = await getTokenFn(fetchImpl);
        let activeDefault = effectiveDefaultModel;
        let activeTiers = modelTiers;
        let catalogModels = Array.isArray(providedModels) ? providedModels : [];
        if (dynamicSettings || (!catalogModels.length && typeof getModelsFn === 'function')) {
          try {
            const cat = await resolveModelsFn({ fetchImpl });
            catalogModels = Array.isArray(cat?.models) ? cat.models : [];
          } catch {
            // Keep providedModels / empty catalog when model fetch fails.
          }
        }
        if (dynamicSettings) {
          if (!activeDefault && catalogModels.length) {
            activeDefault = catalogModels[0].slug;
          }
          activeTiers = selectModelTiers(catalogModels, activeDefault);
        }

        const responsesPayload = buildResponsesPayload(body, {
          defaultModel: activeDefault,
          modelTiers: activeTiers,
          reasoningEffort: effectiveEffort,
          modelCatalog: catalogModels,
          effortPinned: true,
        });

        const reqModelLower = String(body?.model || '').trim().toLowerCase().replace(/\[1m\]$/i, '').trim();
        const isFastTierReq =
          reqModelLower === 'haiku' ||
          reqModelLower.startsWith('claude-haiku') ||
          Boolean(activeTiers?.haiku && responsesPayload.model === activeTiers.haiku && responsesPayload.model !== activeDefault);
        const reqEntry = telemetry.beginRequest({
          requestedModel: body?.model || '',
          targetModel: responsesPayload.model,
          effort: responsesPayload.reasoning?.effort || '',
          stream: body?.stream === true,
          fastTier: isFastTierReq,
        });

        const abortController = new AbortController();
        res.on('close', () => {
          if (!res.writableEnded) {
            abortController.abort();
            telemetry.finishRequest(reqEntry, { status: 'aborted', error: 'Client disconnected' });
          }
        });

        let upstreamRes;
        try {
          upstreamRes = await callOpenAIResponsesStream({
            apiBaseUrl: settings.apiBaseUrl,
            accessToken: upstreamToken,
            payload: responsesPayload,
            signal: abortController.signal,
            fetchImpl,
            onFallback: () => {
              reqEntry.fallbackCount += 1;
            },
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          telemetry.finishRequest(reqEntry, {
            status: err?.name === 'AbortError' ? 'aborted' : 'error',
            error: errMsg,
          });
          if (err?.status === 429 || /rate[_\s-]?limit|quota|too many requests/i.test(errMsg)) {
            try {
              await onQuotaErrorFn({
                status: err?.status || 429,
                model: responsesPayload.model,
                message: errMsg,
                retryAfter: err?.retryAfter || '',
              });
            } catch {
              // Quota logging is best-effort.
            }
          }
          const mappedErr = mapUpstreamErrorToAnthropic(err);
          sendAnthropicError(res, mappedErr.status, mappedErr.type, mappedErr.message);
          return;
        }

        const converter = new ResponsesToAnthropicConverter(
          body?.model || responsesPayload.model
        );

        const recordCompletedUsage = async (errEvent = null) => {
          const toolCalls = converter.toolBlocksByKey.size;
          const webSearchCalls = converter.webSearchCalls.length;
          if (errEvent) {
            const errMsg = errEvent.data?.error?.message || '';
            telemetry.finishRequest(reqEntry, {
              status: 'error',
              usageDetails: converter.usageDetails,
              toolCalls,
              webSearchCalls,
              error: errMsg,
            });
            if (/rate[_\s-]?limit|quota|usage[_\s-]?limit/i.test(errMsg)) {
              try {
                await onQuotaErrorFn({
                  status: 429,
                  model: responsesPayload.model,
                  message: errMsg,
                });
              } catch {
                // Quota logging is best-effort.
              }
            }
            return;
          }
          telemetry.finishRequest(reqEntry, {
            status: 'completed',
            usageDetails: converter.usageDetails,
            toolCalls,
            webSearchCalls,
          });
          try {
            await onUsageFn({
              model: responsesPayload.model,
              requestedModel: body?.model || '',
              source,
              ...converter.usageDetails,
              latencyMs: Date.now() - startedAt,
            });
          } catch {
            // Usage persistence must never break responses.
          }
        };

        const wantsStream = body?.stream === true;

        if (wantsStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          });

          for (const ev of converter.startEvents()) {
            res.write(formatAnthropicSse(ev));
          }

          // Keep the SSE socket active during long xhigh/ultra reasoning pauses.
          const pingTimer = setInterval(() => {
            if (!res.writableEnded) {
              res.write(formatAnthropicSse({ event: 'ping', data: { type: 'ping' } }));
            }
          }, 10_000);
          pingTimer.unref?.();

          let streamError = null;
          try {
            for await (const sseEvent of parseSseStream(upstreamRes.body)) {
              if (sseEvent.data === '[DONE]') break;
              const mapped = converter.processEvent(sseEvent);
              for (const outEv of mapped) {
                if (outEv.event === 'content_block_start' || outEv.event === 'content_block_delta') {
                  telemetry.markFirstToken(reqEntry);
                }
                if (outEv.event === 'error') streamError = outEv;
                res.write(formatAnthropicSse(outEv));
              }
            }
          } catch (streamErr) {
            telemetry.finishRequest(reqEntry, {
              status: streamErr?.name === 'AbortError' ? 'aborted' : 'error',
              usageDetails: converter.usageDetails,
              error: streamErr instanceof Error ? streamErr.message : String(streamErr),
            });
            throw streamErr;
          } finally {
            clearInterval(pingTimer);
          }

          if (!streamError) {
            for (const outEv of converter.finishEvents()) {
              res.write(formatAnthropicSse(outEv));
            }
          }
          await recordCompletedUsage(streamError);
          res.end();
          return;
        }

        // Non-streaming Anthropic request: consume OpenAI SSE and assemble a single JSON message.
        let errorEvent = null;
        try {
          for await (const sseEvent of parseSseStream(upstreamRes.body)) {
            if (sseEvent.data === '[DONE]') break;
            const mapped = converter.processEvent(sseEvent);
            for (const outEv of mapped) {
              if (outEv.event === 'content_block_start' || outEv.event === 'content_block_delta') {
                telemetry.markFirstToken(reqEntry);
              }
              if (outEv.event === 'error') errorEvent = outEv;
            }
          }
        } catch (streamErr) {
          telemetry.finishRequest(reqEntry, {
            status: streamErr?.name === 'AbortError' ? 'aborted' : 'error',
            usageDetails: converter.usageDetails,
            error: streamErr instanceof Error ? streamErr.message : String(streamErr),
          });
          throw streamErr;
        }
        converter.finishEvents();
        await recordCompletedUsage(errorEvent);

        if (errorEvent) {
          const msg = errorEvent.data?.error?.message || 'Upstream streaming failure';
          const mapped = mapUpstreamErrorToAnthropic({ status: 502, upstreamMessage: msg });
          sendAnthropicError(res, mapped.status, mapped.type, mapped.message);
          return;
        }

        sendJson(res, 200, converter.toAnthropicMessage());
        return;
      }

      sendAnthropicError(res, 404, 'not_found_error', `Unsupported endpoint: ${req.method} ${path}`);
    } catch (err) {
      if (err?.name === 'AbortError') {
        if (!res.writableEnded) res.end();
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        if (message.startsWith('Invalid JSON request body')) {
          sendAnthropicError(res, 400, 'invalid_request_error', message);
        } else {
          const mapped = mapUpstreamErrorToAnthropic(err);
          sendAnthropicError(res, mapped.status, mapped.type, mapped.message);
        }
      } else if (!res.writableEnded) {
        res.write(
          formatAnthropicSse({
            event: 'error',
            data: { type: 'error', error: { type: 'api_error', message } },
          })
        );
        res.end();
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(port) || 0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    port: addr.port,
    token: proxyToken,
    getMonitorSnapshot: () => telemetry.snapshot(),
    close: () => {
      telemetry.closeAll();
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
