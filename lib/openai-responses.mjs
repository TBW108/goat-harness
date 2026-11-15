import { randomUUID } from 'node:crypto';
import { proxyFetch } from './proxy-fetch.mjs';

function sanitizeSchemaNode(node) {
  if (node === null || typeof node !== 'object') {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((item) => sanitizeSchemaNode(item));
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$schema') continue;
    out[k] = sanitizeSchemaNode(v);
  }
  if (out.type === 'array' && !out.items) {
    out.items = {};
  }
  if (
    out.type === 'object' &&
    !out.properties &&
    out.additionalProperties === undefined &&
    !out.oneOf &&
    !out.anyOf &&
    !out.allOf
  ) {
    out.properties = {};
  }
  return out;
}

/**
 * Recursively strips unsupported JSON Schema keywords (such as $schema) and fills safe defaults
 * required by OpenAI Responses tool schemas (such as array `items`).
 * @param {any} schema
 * @returns {any}
 */
export function sanitizeJsonSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  return sanitizeSchemaNode(schema);
}

export function extractSystemInstructions(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((part) => (typeof part === 'string' ? part : part?.type === 'text' ? part.text || '' : ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

function sanitizeDocumentFilename(title, mediaType) {
  const raw = String(title || '').trim();
  if (raw) return raw.slice(0, 120);
  if (mediaType === 'application/pdf') return 'document.pdf';
  const ext = String(mediaType || '').split('/')[1]?.replace(/[^a-zA-Z0-9_-]/g, '') || 'bin';
  return `document.${ext}`;
}

function mapUserImageBlock(block) {
  const src = block?.source;
  if (!src) return null;
  if (src.type === 'base64' && src.data) {
    const mediaType = src.media_type || 'image/png';
    return {
      type: 'input_image',
      image_url: `data:${mediaType};base64,${src.data}`,
    };
  }
  if (src.type === 'url' && src.url) {
    return {
      type: 'input_image',
      image_url: src.url,
    };
  }
  return null;
}

function mapDocumentBlock(block) {
  const src = block?.source;
  if (!src || typeof src !== 'object') return [];
  if (src.type === 'base64' && src.data) {
    const mediaType = String(src.media_type || 'application/pdf').trim();
    if (mediaType.startsWith('text/')) {
      return [{ type: 'input_text', text: Buffer.from(src.data, 'base64').toString('utf-8') }];
    }
    return [
      {
        type: 'input_file',
        filename: sanitizeDocumentFilename(block.title, mediaType),
        file_data: `data:${mediaType};base64,${src.data}`,
      },
    ];
  }
  if (src.type === 'text' && src.data !== undefined) {
    return [{ type: 'input_text', text: String(src.data) }];
  }
  if (src.type === 'url' && src.url) {
    return [{ type: 'input_file', file_url: String(src.url) }];
  }
  if (src.type === 'content' && Array.isArray(src.content)) {
    return src.content.flatMap((inner) => mapInputContentBlock(inner));
  }
  return [];
}

function mapInputContentBlock(block) {
  if (typeof block === 'string') {
    return block ? [{ type: 'input_text', text: block }] : [];
  }
  if (!block || typeof block !== 'object') return [];
  if (block.type === 'text') {
    return [{ type: 'input_text', text: block.text || '' }];
  }
  if (block.type === 'image') {
    const img = mapUserImageBlock(block);
    return img ? [img] : [];
  }
  if (block.type === 'document') {
    return mapDocumentBlock(block);
  }
  if (block.type === 'tool_reference' && block.tool_name) {
    return [{ type: 'input_text', text: `Unlocked tool: ${block.tool_name}` }];
  }
  return [];
}

function serializeToolResultContent(content, isError) {
  if (typeof content === 'string') {
    return isError ? (content ? `[ERROR]\n${content}` : '[ERROR] Tool execution failed.') : content || 'OK';
  }

  if (Array.isArray(content)) {
    const mappedParts = [];
    for (const block of content) {
      if (typeof block === 'string') {
        if (block) mappedParts.push({ type: 'input_text', text: block });
        continue;
      }
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' || block.type === 'image' || block.type === 'document' || block.type === 'tool_reference') {
        mappedParts.push(...mapInputContentBlock(block));
        continue;
      }
      mappedParts.push({ type: 'input_text', text: JSON.stringify(block) });
    }

    const hasRichMedia = mappedParts.some(
      (part) => part.type === 'input_image' || part.type === 'input_file'
    );
    if (hasRichMedia) {
      if (isError) {
        return [{ type: 'input_text', text: '[ERROR]' }, ...mappedParts];
      }
      return mappedParts;
    }

    const text = mappedParts.map((part) => part.text || '').filter(Boolean).join('\n');
    return isError ? (text ? `[ERROR]\n${text}` : '[ERROR] Tool execution failed.') : text || 'OK';
  }

  const text = content != null ? JSON.stringify(content) : '';
  return isError ? (text ? `[ERROR]\n${text}` : '[ERROR] Tool execution failed.') : text || 'OK';
}

/**
 * Converts Anthropic /v1/messages `messages` array to stateless OpenAI Responses `input` items.
 * @param {Array<{role: string, content: any}>} messages
 * @returns {Array<Record<string, any>>}
 */
export function anthropicMessagesToResponsesInput(messages, { reconcile = false } = {}) {
  const input = [];
  if (!Array.isArray(messages)) return input;

  for (const msg of messages) {
    const role = msg?.role === 'assistant' ? 'assistant' : 'user';
    const content = msg?.content;

    if (typeof content === 'string') {
      if (content) {
        input.push({
          type: 'message',
          role,
          content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }],
        });
      }
      continue;
    }

    if (!Array.isArray(content)) continue;

    let bufferedParts = [];
    const flushParts = () => {
      if (!bufferedParts.length) return;
      input.push({
        type: 'message',
        role,
        content: bufferedParts,
      });
      bufferedParts = [];
    };

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;

      if (role === 'user') {
        if (block.type === 'tool_result') {
          flushParts();
          input.push({
            type: 'function_call_output',
            call_id: String(block.tool_use_id || ''),
            output: serializeToolResultContent(block.content, Boolean(block.is_error)),
          });
        } else {
          bufferedParts.push(...mapInputContentBlock(block));
        }
      } else {
        if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          continue;
        }
        if (block.type === 'text') {
          if (block.text) {
            bufferedParts.push({ type: 'output_text', text: block.text });
          }
        } else if (block.type === 'tool_use') {
          flushParts();
          input.push({
            type: 'function_call',
            call_id: String(block.id || `call_${randomUUID()}`),
            name: String(block.name || ''),
            arguments:
              typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
          });
        }
      }
    }

    flushParts();
  }

  return reconcile ? reconcileToolCallsAndOutputs(input) : input;
}

/**
 * Ensures every `function_call` has a matching downstream `function_call_output` and every
 * `function_call_output` pairs with an existing preceding `function_call`, preventing HTTP 400
 * errors on interrupted (`Esc`) or compacted conversations.
 */
function reconcileToolCallsAndOutputs(input) {
  const seenCallIds = new Set();
  const validOutputCallIds = new Set();

  for (const item of input) {
    if (item?.type === 'function_call' && item.call_id) {
      seenCallIds.add(item.call_id);
    } else if (item?.type === 'function_call_output' && item.call_id && seenCallIds.has(item.call_id)) {
      validOutputCallIds.add(item.call_id);
    }
  }

  const emittedOutputCallIds = new Set();
  const normalized = [];
  let pendingCallIds = [];
  let inCallBatch = false;

  const flushMissingCalls = () => {
    for (const cid of pendingCallIds) {
      if (!validOutputCallIds.has(cid) && !emittedOutputCallIds.has(cid)) {
        emittedOutputCallIds.add(cid);
        normalized.push({
          type: 'function_call_output',
          call_id: cid,
          output: '[Tool execution interrupted or cancelled before completion.]',
        });
      }
    }
    pendingCallIds = [];
    inCallBatch = false;
  };

  for (const item of input) {
    if (item?.type === 'function_call') {
      if (inCallBatch && pendingCallIds.some((cid) => emittedOutputCallIds.has(cid))) {
        flushMissingCalls();
      }
      normalized.push(item);
      if (item.call_id) pendingCallIds.push(item.call_id);
      inCallBatch = true;
      continue;
    }

    if (item?.type === 'function_call_output') {
      if (item.call_id && validOutputCallIds.has(item.call_id) && !emittedOutputCallIds.has(item.call_id)) {
        emittedOutputCallIds.add(item.call_id);
        normalized.push(item);
      } else {
        flushMissingCalls();
        const text =
          typeof item.output === 'string'
            ? item.output
            : Array.isArray(item.output)
              ? item.output.map((p) => (p?.type === 'input_text' ? p.text : '')).filter(Boolean).join('\n')
              : '';
        if (text) {
          normalized.push({
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: `[Tool result]\n${text}` }],
          });
        }
      }
      continue;
    }

    flushMissingCalls();
    normalized.push(item);
  }

  flushMissingCalls();
  return normalized;
}

export function anthropicToolsToResponsesTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  let hasWebSearch = false;
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const rawType = String(tool.type || '').trim();
    // Map Anthropic server-side web search tool (`web_search_20250305` / `web_search_*`) to OpenAI `web_search`.
    if (rawType.startsWith('web_search') && !tool.input_schema) {
      if (!hasWebSearch) {
        hasWebSearch = true;
        const wsTool = { type: 'web_search' };
        if (Array.isArray(tool.allowed_domains) && tool.allowed_domains.length) {
          const domains = tool.allowed_domains.map((d) => String(d).trim()).filter(Boolean);
          if (domains.length) wsTool.filters = { allowed_domains: domains };
        }
        out.push(wsTool);
      }
      continue;
    }
    if (!tool.name || tool.name === 'DeferredToolPlaceholder') continue;
    // Skip other Anthropic server-executed built-in tools lacking client input_schema.
    if (rawType && rawType !== 'custom' && rawType !== 'function' && !tool.input_schema) {
      continue;
    }
    const params = sanitizeJsonSchema(tool.input_schema);
    if (!params.type) params.type = 'object';
    if (params.type === 'object' && !params.properties) params.properties = {};
    out.push({
      type: 'function',
      name: String(tool.name),
      description: String(tool.description || ''),
      parameters: params,
      strict: false,
    });
  }
  return out;
}

export function mapToolChoice(toolChoice) {
  if (!toolChoice || typeof toolChoice !== 'object') return undefined;
  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'none') return 'none';
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return { type: 'function', name: String(toolChoice.name) };
  }
  return undefined;
}

export const VALID_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function clampReasoningEffort(effort, supportedLevels) {
  const normalized = String(effort || '').trim().toLowerCase();
  if (!normalized || normalized === 'none') return normalized;
  if (!Array.isArray(supportedLevels) || !supportedLevels.length) return normalized;
  if (supportedLevels.includes(normalized)) return normalized;

  const idx = EFFORT_LADDER.indexOf(normalized);
  if (idx !== -1) {
    for (let i = idx - 1; i >= 0; i--) {
      if (supportedLevels.includes(EFFORT_LADDER[i])) return EFFORT_LADDER[i];
    }
    for (let i = idx + 1; i < EFFORT_LADDER.length; i++) {
      if (supportedLevels.includes(EFFORT_LADDER[i])) return EFFORT_LADDER[i];
    }
  }
  return supportedLevels[0];
}

export function resolveTargetModel(requestedModel, defaultModelOrTiers) {
  const req = String(requestedModel || '').trim();
  const tiers =
    defaultModelOrTiers && typeof defaultModelOrTiers === 'object'
      ? {
          default: String(defaultModelOrTiers.default || '').trim(),
          opus: String(defaultModelOrTiers.opus || '').trim(),
          sonnet: String(defaultModelOrTiers.sonnet || '').trim(),
          haiku: String(defaultModelOrTiers.haiku || '').trim(),
        }
      : {
          default: String(defaultModelOrTiers || '').trim(),
          opus: '',
          sonnet: '',
          haiku: '',
        };

  if (!req) return tiers.default || tiers.sonnet || tiers.opus || '';
  if (req === 'opus' || req.startsWith('claude-opus')) {
    return tiers.opus || tiers.default || req;
  }
  if (req === 'haiku' || req.startsWith('claude-haiku')) {
    return tiers.haiku || tiers.default || req;
  }
  if (req === 'sonnet' || req.startsWith('claude-sonnet')) {
    return tiers.default && !tiers.sonnet ? tiers.default : tiers.sonnet || tiers.default || req;
  }
  if (req.startsWith('claude-')) {
    return tiers.default || tiers.sonnet || req;
  }
  return req;
}

/**
 * Builds an OpenAI /v1/responses request body from an Anthropic /v1/messages request body.
 */
export function buildResponsesPayload(
  anthropicReq,
  { defaultModel = '', modelTiers = null, reasoningEffort = '', modelCatalog = null, effortPinned = false } = {}
) {
  const model = resolveTargetModel(anthropicReq?.model, modelTiers || defaultModel);
  if (!model) {
    throw new Error('No OpenAI model selected. Choose a model in GOAT Harness or pass --model.');
  }

  const payload = {
    model,
    input: anthropicMessagesToResponsesInput(anthropicReq?.messages, { reconcile: true }),
    stream: true,
    store: false,
  };

  const instructions = extractSystemInstructions(anthropicReq?.system);
  if (instructions) {
    payload.instructions = instructions;
  }

  const tools = anthropicToolsToResponsesTools(anthropicReq?.tools);
  if (tools.length) {
    payload.tools = tools;
    const tc = mapToolChoice(anthropicReq?.tool_choice);
    if (tc !== undefined) payload.tool_choice = tc;
  }

  if (Number.isFinite(anthropicReq?.max_tokens) && anthropicReq.max_tokens >= 16) {
    payload.max_output_tokens = Math.floor(anthropicReq.max_tokens);
  }

  const modelSpec = Array.isArray(modelCatalog) ? modelCatalog.find((m) => m?.slug === model) : null;
  const thinkingCfg = anthropicReq?.thinking;
  const thinkingDisabled = thinkingCfg?.type === 'disabled';
  const wantsReasoningSummary = Boolean(
    thinkingCfg &&
      thinkingCfg.type !== 'disabled' &&
      thinkingCfg.display !== 'omitted' &&
      modelSpec?.supportsReasoningSummary !== false
  );

  let effectiveEffort = '';
  if (thinkingDisabled) {
    effectiveEffort = 'none';
  } else {
    const reqEffort = String(anthropicReq?.output_config?.effort || '').trim().toLowerCase();
    const baseEffort = String(reasoningEffort || '').trim().toLowerCase();
    const isExtendedPinned = effortPinned && baseEffort === 'ultra';
    if (isExtendedPinned && (!reqEffort || reqEffort === 'high' || reqEffort === 'max')) {
      effectiveEffort = baseEffort;
    } else if (reqEffort && VALID_REASONING_EFFORTS.includes(reqEffort)) {
      effectiveEffort = reqEffort;
    } else if (baseEffort && VALID_REASONING_EFFORTS.includes(baseEffort)) {
      effectiveEffort = baseEffort;
    }
    if (effectiveEffort) {
      effectiveEffort = clampReasoningEffort(effectiveEffort, modelSpec?.supportedReasoningLevels);
    }
  }

  if (effectiveEffort || wantsReasoningSummary) {
    payload.reasoning = {
      ...(effectiveEffort ? { effort: effectiveEffort } : {}),
      ...(wantsReasoningSummary ? { summary: 'auto' } : {}),
    };
  }

  return payload;
}

/**
 * Parses an HTTP text/event-stream body into individual { event, data } objects.
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {AsyncGenerator<{event: string, data: any}>}
 */
export async function* parseSseStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatchFrame = (frame) => {
    const lines = frame.split('\n');
    let eventName = 'message';
    const dataLines = [];
    for (const line of lines) {
      if (!line || line.startsWith(':')) continue;
      const colonIdx = line.indexOf(':');
      const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
      let value = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') eventName = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (!dataLines.length) return null;
    const rawData = dataLines.join('\n');
    if (rawData === '[DONE]') return { event: 'done', data: '[DONE]' };
    try {
      return { event: eventName, data: JSON.parse(rawData) };
    } catch {
      return { event: eventName, data: rawData };
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = dispatchFrame(frame);
          if (parsed) yield parsed;
          boundary = buffer.indexOf('\n\n');
        }
      }
      if (done) {
        buffer += decoder.decode().replace(/\r\n/g, '\n');
        if (buffer.trim()) {
          const parsed = dispatchFrame(buffer.trim());
          if (parsed) yield parsed;
        }
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Stateful converter that transforms OpenAI Responses SSE events into
 * Anthropic Messages SSE events (or a single aggregated Anthropic Message JSON).
 */
export class ResponsesToAnthropicConverter {
  constructor(requestedModel) {
    this.requestedModel = requestedModel;
    this.messageId = `msg_${randomUUID().replace(/-/g, '')}`;
    this.nextBlockIndex = 0;
    this.openTextBlock = null; // { index, text }
    this.openThinkingBlock = null; // { index, thinking }
    this.toolBlocksByKey = new Map(); // itemId / outputIndex -> { index, id, name, jsonBuffer, closed }
    this.completedBlocks = [];
    this.webSearchCalls = []; // { id, query }
    this.webResultsByUrl = new Map(); // url -> { url, title }
    this.emittedWebSearchBlocks = false;
    this.hasToolUse = false;
    this.started = false;
    this.finished = false;
    this.usage = { input_tokens: 0, output_tokens: 0 };
    this.usageDetails = {
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    };
    this.stopReason = 'end_turn';
  }

  startEvents() {
    if (this.started) return [];
    this.started = true;
    return [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: this.messageId,
            type: 'message',
            role: 'assistant',
            model: this.requestedModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
      },
      { event: 'ping', data: { type: 'ping' } },
    ];
  }

  #closeThinking(out) {
    if (!this.openThinkingBlock) return;
    const blk = this.openThinkingBlock;
    this.openThinkingBlock = null;
    this.completedBlocks[blk.index] = { type: 'thinking', thinking: blk.thinking };
    out.push({
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: blk.index },
    });
  }

  #closeText(out) {
    if (!this.openTextBlock) return;
    const blk = this.openTextBlock;
    this.openTextBlock = null;
    this.completedBlocks[blk.index] = { type: 'text', text: blk.text };
    out.push({
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: blk.index },
    });
  }

  #recordCitations(annotations) {
    if (!Array.isArray(annotations)) return;
    for (const ann of annotations) {
      if (ann?.type !== 'url_citation' || !ann.url) continue;
      const url = String(ann.url).trim();
      if (!url) continue;
      const title = String(ann.title || '').trim();
      const prev = this.webResultsByUrl.get(url);
      if (!prev || (!prev.title && title)) {
        this.webResultsByUrl.set(url, { url, title });
      }
    }
  }

  #emitServerWebSearchBlocks(out) {
    if (this.emittedWebSearchBlocks) return;
    if (!this.webSearchCalls.length && !this.webResultsByUrl.size) return;
    this.emittedWebSearchBlocks = true;
    this.#closeThinking(out);
    this.#closeText(out);

    const calls = this.webSearchCalls.length
      ? this.webSearchCalls
      : [
          {
            id: `srvtoolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
            query: '',
          },
        ];
    const searchResults = Array.from(this.webResultsByUrl.values()).map((r) => ({
      type: 'web_search_result',
      url: r.url,
      title: r.title || r.url,
      encrypted_content: '',
      page_age: '',
    }));

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const useIndex = this.nextBlockIndex++;
      const serverUseBlock = {
        type: 'server_tool_use',
        id: call.id,
        name: 'web_search',
        input: { query: call.query || '' },
      };
      this.completedBlocks[useIndex] = serverUseBlock;
      out.push({
        event: 'content_block_start',
        data: { type: 'content_block_start', index: useIndex, content_block: serverUseBlock },
      });
      out.push({
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: useIndex },
      });

      const resultIndex = this.nextBlockIndex++;
      const resultBlock = {
        type: 'web_search_tool_result',
        tool_use_id: call.id,
        content: i === calls.length - 1 ? searchResults : [],
      };
      this.completedBlocks[resultIndex] = resultBlock;
      out.push({
        event: 'content_block_start',
        data: { type: 'content_block_start', index: resultIndex, content_block: resultBlock },
      });
      out.push({
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: resultIndex },
      });
    }
  }

  #ensureThinking(out) {
    if (this.openThinkingBlock) return this.openThinkingBlock;
    this.#closeText(out);
    const index = this.nextBlockIndex++;
    this.openThinkingBlock = { index, thinking: '' };
    out.push({
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '' },
      },
    });
    return this.openThinkingBlock;
  }

  #ensureText(out) {
    if (this.openTextBlock) return this.openTextBlock;
    this.#closeThinking(out);
    const index = this.nextBlockIndex++;
    this.openTextBlock = { index, text: '' };
    out.push({
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      },
    });
    return this.openTextBlock;
  }

  #openToolBlock(out, { itemId, outputIndex, callId, name }) {
    this.#closeThinking(out);
    this.#closeText(out);
    const key = itemId || `idx:${outputIndex}`;
    if (this.toolBlocksByKey.has(key)) return this.toolBlocksByKey.get(key);

    const index = this.nextBlockIndex++;
    const id = String(callId || itemId || `toolu_${randomUUID().replace(/-/g, '')}`);
    const block = {
      index,
      id,
      name: String(name || 'tool'),
      jsonBuffer: '',
      closed: false,
    };
    this.toolBlocksByKey.set(key, block);
    if (itemId) this.toolBlocksByKey.set(itemId, block);
    if (outputIndex !== undefined && outputIndex !== null) {
      this.toolBlocksByKey.set(`idx:${outputIndex}`, block);
    }
    this.hasToolUse = true;

    out.push({
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id,
          name: block.name,
          input: {},
        },
      },
    });
    return block;
  }

  #closeToolBlock(out, block) {
    if (!block || block.closed) return;
    block.closed = true;
    let parsedInput = {};
    if (block.jsonBuffer.trim()) {
      try {
        parsedInput = JSON.parse(block.jsonBuffer);
      } catch {
        parsedInput = {};
      }
    }
    this.completedBlocks[block.index] = {
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: parsedInput,
    };
    out.push({
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: block.index },
    });
  }

  processEvent(sseEvent) {
    const out = [];
    if (!this.started) out.push(...this.startEvents());
    if (this.finished) return out;

    const data = sseEvent?.data;
    if (!data || typeof data !== 'object') return out;
    const type = data.type || sseEvent.event;

    if (type === 'response.output_item.added') {
      const item = data.item;
      if (item?.type === 'function_call') {
        const blk = this.#openToolBlock(out, {
          itemId: item.id,
          outputIndex: data.output_index,
          callId: item.call_id,
          name: item.name,
        });
        if (typeof item.arguments === 'string' && item.arguments.length) {
          blk.jsonBuffer += item.arguments;
          out.push({
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: blk.index,
              delta: { type: 'input_json_delta', partial_json: item.arguments },
            },
          });
        }
      }
      return out;
    }

    if (type === 'response.reasoning_summary_part.added') {
      if (
        this.openThinkingBlock &&
        this.openThinkingBlock.thinking.trim() &&
        !this.openThinkingBlock.thinking.endsWith('\n\n')
      ) {
        const sep = this.openThinkingBlock.thinking.endsWith('\n') ? '\n' : '\n\n';
        this.openThinkingBlock.thinking += sep;
        out.push({
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: this.openThinkingBlock.index,
            delta: { type: 'thinking_delta', thinking: sep },
          },
        });
      }
      return out;
    }

    if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      const delta = typeof data.delta === 'string' ? data.delta : '';
      if (delta) {
        const blk = this.#ensureThinking(out);
        blk.thinking += delta;
        out.push({
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: blk.index,
            delta: { type: 'thinking_delta', thinking: delta },
          },
        });
      }
      return out;
    }

    if (type === 'response.output_text.delta') {
      const delta = typeof data.delta === 'string' ? data.delta : '';
      if (delta) {
        const blk = this.#ensureText(out);
        blk.text += delta;
        out.push({
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: blk.index,
            delta: { type: 'text_delta', text: delta },
          },
        });
      }
      return out;
    }

    if (type === 'response.function_call_arguments.delta') {
      const blk =
        this.toolBlocksByKey.get(data.item_id) ||
        this.toolBlocksByKey.get(`idx:${data.output_index}`);
      const delta = typeof data.delta === 'string' ? data.delta : '';
      if (blk && delta) {
        blk.jsonBuffer += delta;
        out.push({
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: blk.index,
            delta: { type: 'input_json_delta', partial_json: delta },
          },
        });
      }
      return out;
    }

    if (type === 'response.function_call_arguments.done') {
      const blk =
        this.toolBlocksByKey.get(data.item_id) ||
        this.toolBlocksByKey.get(`idx:${data.output_index}`);
      if (blk && !blk.jsonBuffer) {
        const fallbackJson =
          typeof data.arguments === 'string' && data.arguments ? data.arguments : '{}';
        blk.jsonBuffer = fallbackJson;
        out.push({
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: blk.index,
            delta: { type: 'input_json_delta', partial_json: fallbackJson },
          },
        });
      }
      if (blk) this.#closeToolBlock(out, blk);
      return out;
    }

    if (type === 'response.output_item.done') {
      const item = data.item;
      if (item?.type === 'function_call') {
        const blk =
          this.toolBlocksByKey.get(item.id) ||
          this.toolBlocksByKey.get(`idx:${data.output_index}`) ||
          this.#openToolBlock(out, {
            itemId: item.id,
            outputIndex: data.output_index,
            callId: item.call_id,
            name: item.name,
          });
        if (!blk.jsonBuffer) {
          const fallbackJson =
            typeof item.arguments === 'string' && item.arguments ? item.arguments : '{}';
          blk.jsonBuffer = fallbackJson;
          out.push({
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: blk.index,
              delta: { type: 'input_json_delta', partial_json: fallbackJson },
            },
          });
        }
        this.#closeToolBlock(out, blk);
      } else if (item?.type === 'web_search_call') {
        const action = item.action || {};
        if (action.type === 'open_page' && action.url) {
          const url = String(action.url).trim();
          if (url && !this.webResultsByUrl.has(url)) {
            this.webResultsByUrl.set(url, { url, title: '' });
          }
        } else {
          const query = String(action.query || action.queries?.[0] || '').trim();
          const id = item.id
            ? `srvtoolu_${String(item.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 28)}`
            : `srvtoolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
          this.webSearchCalls.push({ id, query });
        }
      } else if (item?.type === 'message') {
        if (Array.isArray(item.content)) {
          for (const part of item.content) {
            this.#recordCitations(part?.annotations);
          }
        }
        // Fallback if text arrived only in output_item.done without output_text.delta
        if (!this.openTextBlock && Array.isArray(item.content)) {
          const joined = item.content
            .filter((c) => c?.type === 'output_text' && c.text)
            .map((c) => c.text)
            .join('');
          if (joined) {
            const blk = this.#ensureText(out);
            blk.text += joined;
            out.push({
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: blk.index,
                delta: { type: 'text_delta', text: joined },
              },
            });
          }
        }
        this.#closeText(out);
      } else if (item?.type === 'reasoning') {
        this.#closeThinking(out);
      }
      return out;
    }

    if (type === 'response.content_part.done') {
      this.#recordCitations(data.part?.annotations);
      return out;
    }

    if (type === 'response.completed' || type === 'response.incomplete') {
      const resp = data.response || {};
      const wsCount = Number(resp.tool_usage?.web_search?.num_requests || this.webSearchCalls.length || 0);
      if (resp.usage) {
        const inputTokens = Number(resp.usage.input_tokens || 0);
        const cachedTokens = Number(resp.usage.input_tokens_details?.cached_tokens || 0);
        const outputTokens = Number(resp.usage.output_tokens || 0);
        const reasoningTokens = Number(resp.usage.output_tokens_details?.reasoning_tokens || 0);
        const totalTokens = Number(resp.usage.total_tokens || inputTokens + outputTokens);
        const uncachedInputTokens = cachedTokens > 0 ? Math.max(0, inputTokens - cachedTokens) : inputTokens;
        this.usage = {
          input_tokens: uncachedInputTokens,
          output_tokens: outputTokens,
          ...(cachedTokens > 0 ? { cache_read_input_tokens: cachedTokens } : {}),
          ...(wsCount > 0 ? { server_tool_use: { web_search_requests: wsCount } } : {}),
        };
        this.usageDetails = {
          inputTokens,
          cachedTokens,
          outputTokens,
          reasoningTokens,
          totalTokens,
        };
      }
      this.#closeThinking(out);
      this.#closeText(out);
      for (const blk of this.toolBlocksByKey.values()) {
        this.#closeToolBlock(out, blk);
      }
      this.#emitServerWebSearchBlocks(out);

      if (this.hasToolUse) {
        this.stopReason = 'tool_use';
      } else if (resp.incomplete_details?.reason === 'max_output_tokens' || type === 'response.incomplete') {
        this.stopReason = 'max_tokens';
      } else {
        this.stopReason = 'end_turn';
      }

      this.finished = true;
      out.push({
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: this.stopReason, stop_sequence: null },
          usage: this.usage,
        },
      });
      out.push({ event: 'message_stop', data: { type: 'message_stop' } });
      return out;
    }

    if (type === 'response.failed' || type === 'error') {
      const errMsg =
        data.response?.error?.message || data.error?.message || data.message || 'OpenAI Responses stream error';
      this.finished = true;
      out.push({
        event: 'error',
        data: {
          type: 'error',
          error: { type: 'api_error', message: errMsg },
        },
      });
      return out;
    }

    return out;
  }

  finishEvents() {
    if (this.finished) return [];
    const out = [];
    if (!this.started) out.push(...this.startEvents());
    this.#closeThinking(out);
    this.#closeText(out);
    for (const blk of this.toolBlocksByKey.values()) {
      this.#closeToolBlock(out, blk);
    }
    this.#emitServerWebSearchBlocks(out);
    this.stopReason = this.hasToolUse ? 'tool_use' : 'end_turn';
    this.finished = true;
    out.push({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: this.stopReason, stop_sequence: null },
        usage: this.usage,
      },
    });
    out.push({ event: 'message_stop', data: { type: 'message_stop' } });
    return out;
  }

  toAnthropicMessage() {
    const content = this.completedBlocks.filter(Boolean);
    return {
      id: this.messageId,
      type: 'message',
      role: 'assistant',
      model: this.requestedModel,
      content,
      stop_reason: this.stopReason,
      stop_sequence: null,
      usage: this.usage,
    };
  }
}

export function formatAnthropicSse(eventObj) {
  return `event: ${eventObj.event}\ndata: ${JSON.stringify(eventObj.data)}\n\n`;
}

function buildUpstreamHttpError(status, rawText, retryAfter = '') {
  let parsed = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    parsed = null;
  }
  const upstreamErr = parsed?.error && typeof parsed.error === 'object' ? parsed.error : null;
  const upstreamMessage = String(upstreamErr?.message || parsed?.message || rawText || '').trim();
  const err = new Error(`OpenAI /v1/responses HTTP ${status}: ${upstreamMessage || rawText}`);
  err.status = status;
  err.retryAfter = retryAfter;
  err.upstreamMessage = upstreamMessage || rawText;
  err.upstreamType = String(upstreamErr?.type || '');
  err.upstreamCode = String(upstreamErr?.code || '');
  return err;
}

function flattenMultimodalToolOutputs(input) {
  let changed = false;
  const nextInput = (Array.isArray(input) ? input : []).map((item) => {
    if (item?.type !== 'function_call_output' || !Array.isArray(item.output)) return item;
    changed = true;
    const text = item.output
      .map((part) => {
        if (part?.type === 'input_text') return part.text || '';
        if (part?.type === 'input_image') return '[image omitted]';
        if (part?.type === 'input_file') return `[file omitted: ${part.filename || 'document'}]`;
        return JSON.stringify(part);
      })
      .filter(Boolean)
      .join('\n');
    return { ...item, output: text || 'OK' };
  });
  return changed ? nextInput : null;
}

function degradeResponsesPayloadFor400(body, errText) {
  const lowered = String(errText || '').toLowerCase();
  if (lowered.includes('summary') && body.reasoning?.summary) {
    const nextReasoning = { ...body.reasoning };
    delete nextReasoning.summary;
    const next = { ...body };
    if (Object.keys(nextReasoning).length) next.reasoning = nextReasoning;
    else delete next.reasoning;
    return next;
  }
  if ((lowered.includes('ultra') || lowered.includes('reasoning.effort')) && body.reasoning?.effort === 'ultra') {
    return { ...body, reasoning: { ...body.reasoning, effort: 'max' } };
  }
  if (
    (lowered.includes('reasoning') ||
      lowered.includes('effort') ||
      (body.reasoning?.effort === 'none' && lowered.includes('none'))) &&
    body.reasoning
  ) {
    const next = { ...body };
    delete next.reasoning;
    return next;
  }
  if (lowered.includes('max_output_tokens') && body.max_output_tokens) {
    const next = { ...body };
    delete next.max_output_tokens;
    return next;
  }
  if (
    lowered.includes('filters') &&
    Array.isArray(body.tools) &&
    body.tools.some((t) => t.type === 'web_search' && t.filters)
  ) {
    return {
      ...body,
      tools: body.tools.map((t) => (t.type === 'web_search' ? { type: 'web_search' } : t)),
    };
  }
  if (
    lowered.includes('function_call_output') ||
    lowered.includes('input_image') ||
    lowered.includes('input_file')
  ) {
    const flattened = flattenMultimodalToolOutputs(body.input);
    if (flattened) {
      return { ...body, input: flattened };
    }
  }
  return null;
}

/**
 * Calls OpenAI /v1/responses with retry fallback for optional parameters (e.g., reasoning, summary,
 * max_output_tokens, web_search.filters, or multimodal function_call_output) if a model rejects them with HTTP 400.
 */
export async function callOpenAIResponsesStream({
  apiBaseUrl,
  accessToken,
  payload,
  signal,
  fetchImpl = proxyFetch,
}) {
  const base = String(apiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const endpoint = `${base}/responses`;

  const tryPost = async (bodyObj) => {
    return fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(bodyObj),
      signal,
    });
  };

  let currentBody = { ...payload };
  let res = await tryPost(currentBody);

  for (let retry = 0; retry < 4 && res.status === 400; retry++) {
    const errText = await res.text();
    const downgraded = degradeResponsesPayloadFor400(currentBody, errText);
    if (!downgraded) {
      throw buildUpstreamHttpError(400, errText, res.headers?.get?.('retry-after') || '');
    }
    currentBody = downgraded;
    res = await tryPost(currentBody);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw buildUpstreamHttpError(res.status, errText, res.headers?.get?.('retry-after') || '');
  }

  if (!res.body) {
    throw new Error('OpenAI /v1/responses returned an empty response body.');
  }

  return res;
}
