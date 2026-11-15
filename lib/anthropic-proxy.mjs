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

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const path = reqUrl.pathname;

    try {
      if (req.method === 'GET' && path === '/health') {
        const bound = server.address();
        sendJson(res, 200, {
          ok: true,
          pid: process.pid,
          port: bound && typeof bound === 'object' ? bound.port : Number(port) || 0,
          dynamicSettings: Boolean(dynamicSettings),
        });
        return;
      }

      if (!checkLocalAuth(req, proxyToken)) {
        sendAnthropicError(res, 401, 'authentication_error', 'Invalid local proxy token.');
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

        const abortController = new AbortController();
        res.on('close', () => {
          if (!res.writableEnded) abortController.abort();
        });

        let upstreamRes;
        try {
          upstreamRes = await callOpenAIResponsesStream({
            apiBaseUrl: settings.apiBaseUrl,
            accessToken: upstreamToken,
            payload: responsesPayload,
            signal: abortController.signal,
            fetchImpl,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
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

        const recordCompletedUsage = async (errEvent = null) => {
          if (errEvent) {
            const errMsg = errEvent.data?.error?.message || '';
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

        const converter = new ResponsesToAnthropicConverter(
          body?.model || responsesPayload.model
        );
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
                if (outEv.event === 'error') streamError = outEv;
                res.write(formatAnthropicSse(outEv));
              }
            }
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
        for await (const sseEvent of parseSseStream(upstreamRes.body)) {
          if (sseEvent.data === '[DONE]') break;
          const mapped = converter.processEvent(sseEvent);
          for (const outEv of mapped) {
            if (outEv.event === 'error') errorEvent = outEv;
          }
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
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
