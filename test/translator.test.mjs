import assert from 'node:assert/strict';
import test from 'node:test';
import {
  anthropicMessagesToResponsesInput,
  anthropicToolsToResponsesTools,
  buildResponsesPayload,
  callOpenAIResponsesStream,
  clampReasoningEffort,
  resolveTargetModel,
  ResponsesToAnthropicConverter,
} from '../lib/openai-responses.mjs';

test('buildResponsesPayload translates system, messages, tools, tool_choice, and claude alias', () => {
  const payload = buildResponsesPayload(
    {
      model: 'claude-sonnet-4-6',
      system: [
        { type: 'text', text: 'System A', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'System B' },
      ],
      max_tokens: 4096,
      tool_choice: { type: 'any' },
      tools: [
        {
          name: 'Read',
          description: 'Read a file',
          input_schema: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            properties: {
              file_path: { type: 'string' },
              mode: { type: 'string', enum: ['full', 'head'] },
            },
            required: ['file_path'],
          },
        },
      ],
      messages: [
        { role: 'user', content: 'Inspect package.json' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'internal thought' },
            { type: 'text', text: 'Let me read it.' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'package.json' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"name":"goat"}' },
          ],
        },
      ],
    },
    { defaultModel: 'gpt-5-codex', reasoningEffort: 'high' }
  );

  assert.equal(payload.model, 'gpt-5-codex');
  assert.equal(payload.store, false);
  assert.equal(payload.stream, true);
  assert.equal(payload.instructions, 'System A\n\nSystem B');
  assert.equal(payload.tool_choice, 'required');
  assert.equal(payload.max_output_tokens, 4096);
  assert.deepEqual(payload.reasoning, { effort: 'high' });

  assert.equal(payload.tools.length, 1);
  assert.equal(payload.tools[0].parameters.$schema, undefined);
  assert.deepEqual(payload.tools[0].parameters.required, ['file_path']);
  assert.deepEqual(payload.tools[0].parameters.properties.mode.enum, ['full', 'head']);
  assert.equal(payload.tools[0].strict, false);

  assert.deepEqual(payload.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect package.json' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Let me read it.' }] },
    {
      type: 'function_call',
      call_id: 'toolu_1',
      name: 'Read',
      arguments: '{"file_path":"package.json"}',
    },
    { type: 'function_call_output', call_id: 'toolu_1', output: '{"name":"goat"}' },
  ]);
});

test('anthropicMessagesToResponsesInput handles error tool_result and base64 images', () => {
  const input = anthropicMessagesToResponsesInput([
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'ENOENT' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
        },
      ],
    },
  ]);

  assert.equal(input[0].type, 'function_call_output');
  assert.equal(input[0].output, '[ERROR]\nENOENT');
  assert.equal(input[1].type, 'message');
  assert.equal(input[1].content[0].image_url, 'data:image/png;base64,AAAA');
});

test('anthropicToolsToResponsesTools provides safe defaults for minimal schemas', () => {
  const tools = anthropicToolsToResponsesTools([{ name: 'Ping' }]);
  assert.deepEqual(tools, [
    {
      type: 'function',
      name: 'Ping',
      description: '',
      parameters: { type: 'object', properties: {} },
      strict: false,
    },
  ]);
});

test('ResponsesToAnthropicConverter converts reasoning, text, and tool calls accurately', () => {
  const conv = new ResponsesToAnthropicConverter('gpt-5-codex');
  const events = [
    ...conv.startEvents(),
    ...conv.processEvent({
      event: 'response.reasoning_summary_text.delta',
      data: { type: 'response.reasoning_summary_text.delta', delta: 'Thinking...' },
    }),
    ...conv.processEvent({
      event: 'response.output_text.delta',
      data: { type: 'response.output_text.delta', delta: 'Calling Read.' },
    }),
    ...conv.processEvent({
      event: 'response.output_item.added',
      data: {
        type: 'response.output_item.added',
        output_index: 1,
        item: { id: 'fc_1', call_id: 'call_abc', type: 'function_call', name: 'Read', arguments: '' },
      },
    }),
    ...conv.processEvent({
      event: 'response.function_call_arguments.delta',
      data: {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        output_index: 1,
        delta: '{"file_path":"a.js"}',
      },
    }),
    ...conv.processEvent({
      event: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        output_index: 1,
        item: { id: 'fc_1', call_id: 'call_abc', type: 'function_call', name: 'Read', arguments: '{"file_path":"a.js"}' },
      },
    }),
    ...conv.processEvent({
      event: 'response.completed',
      data: {
        type: 'response.completed',
        response: { usage: { input_tokens: 120, output_tokens: 35 } },
      },
    }),
  ];

  assert.equal(events[0].event, 'message_start');
  const msgDelta = events.find((e) => e.event === 'message_delta');
  assert.equal(msgDelta.data.delta.stop_reason, 'tool_use');
  assert.deepEqual(msgDelta.data.usage, { input_tokens: 120, output_tokens: 35 });

  const finalMsg = conv.toAnthropicMessage();
  assert.equal(finalMsg.stop_reason, 'tool_use');
  assert.equal(finalMsg.content.length, 3);
  assert.deepEqual(finalMsg.content[0], { type: 'thinking', thinking: 'Thinking...' });
  assert.deepEqual(finalMsg.content[1], { type: 'text', text: 'Calling Read.' });
  assert.deepEqual(finalMsg.content[2], {
    type: 'tool_use',
    id: 'call_abc',
    name: 'Read',
    input: { file_path: 'a.js' },
  });
});

test('resolveTargetModel handles tier map, extended efforts, and detailed usage capture', () => {
  const tiers = {
    default: 'gpt-6.1-sol',
    opus: 'gpt-6-astra',
    sonnet: 'gpt-6.1-sol',
    haiku: 'gpt-6-luna',
  };
  assert.equal(resolveTargetModel('opus', tiers), 'gpt-6-astra');
  assert.equal(resolveTargetModel('claude-opus-4-6', tiers), 'gpt-6-astra');
  assert.equal(resolveTargetModel('claude-haiku-4-5-20251001', tiers), 'gpt-6-luna');
  assert.equal(resolveTargetModel('gpt-6-astra', tiers), 'gpt-6-astra');
  assert.equal(resolveTargetModel('gpt-6.1-terra', tiers), 'gpt-6.1-terra');

  for (const effort of ['xhigh', 'max', 'ultra']) {
    const req = buildResponsesPayload(
      { model: 'opus', messages: [{ role: 'user', content: 'hi' }] },
      { modelTiers: tiers, reasoningEffort: effort }
    );
    assert.equal(req.model, 'gpt-6-astra');
    assert.deepEqual(req.reasoning, { effort });
  }

  const conv = new ResponsesToAnthropicConverter('gpt-6-astra');
  conv.processEvent({
    event: 'response.completed',
    data: {
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 200,
          input_tokens_details: { cached_tokens: 150 },
          output_tokens: 45,
          output_tokens_details: { reasoning_tokens: 20 },
          total_tokens: 245,
        },
      },
    },
  });
  assert.deepEqual(conv.usageDetails, {
    inputTokens: 200,
    cachedTokens: 150,
    outputTokens: 45,
    reasoningTokens: 20,
    totalTokens: 245,
  });
});

test('anthropicToolsToResponsesTools & ResponsesToAnthropicConverter translate built-in web_search end-to-end', () => {
  const mappedTools = anthropicToolsToResponsesTools([
    {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 8,
      allowed_domains: ['nodejs.org', 'openai.com'],
    },
  ]);
  assert.deepEqual(mappedTools, [
    {
      type: 'web_search',
      filters: { allowed_domains: ['nodejs.org', 'openai.com'] },
    },
  ]);

  const conv = new ResponsesToAnthropicConverter('gpt-6.1-sol');
  const events = [
    ...conv.startEvents(),
    ...conv.processEvent({
      event: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        item: {
          id: 'ws_1',
          type: 'web_search_call',
          status: 'completed',
          action: { type: 'search', query: 'Node.js LTS release' },
        },
      },
    }),
    ...conv.processEvent({
      event: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        item: {
          id: 'ws_2',
          type: 'web_search_call',
          status: 'completed',
          action: { type: 'open_page', url: 'https://nodejs.org/en/download' },
        },
      },
    }),
    ...conv.processEvent({
      event: 'response.output_text.delta',
      data: { type: 'response.output_text.delta', delta: 'Current LTS is v26.' },
    }),
    ...conv.processEvent({
      event: 'response.content_part.done',
      data: {
        type: 'response.content_part.done',
        part: {
          type: 'output_text',
          annotations: [
            {
              type: 'url_citation',
              title: 'Node.js — Download Node.js®',
              url: 'https://nodejs.org/en/download',
            },
          ],
        },
      },
    }),
    ...conv.processEvent({
      event: 'response.completed',
      data: {
        type: 'response.completed',
        response: {
          tool_usage: { web_search: { num_requests: 1 } },
          usage: { input_tokens: 500, output_tokens: 30, total_tokens: 530 },
        },
      },
    }),
  ];

  const finalMsg = conv.toAnthropicMessage();
  assert.equal(finalMsg.stop_reason, 'end_turn');
  assert.equal(finalMsg.usage.server_tool_use.web_search_requests, 1);

  const serverUse = finalMsg.content.find((b) => b.type === 'server_tool_use');
  const searchResult = finalMsg.content.find((b) => b.type === 'web_search_tool_result');
  const textBlock = finalMsg.content.find((b) => b.type === 'text');
  assert.equal(textBlock.text, 'Current LTS is v26.');
  assert.equal(serverUse.name, 'web_search');
  assert.deepEqual(serverUse.input, { query: 'Node.js LTS release' });
  assert.equal(searchResult.tool_use_id, serverUse.id);
  assert.deepEqual(searchResult.content, [
    {
      type: 'web_search_result',
      url: 'https://nodejs.org/en/download',
      title: 'Node.js — Download Node.js®',
      encrypted_content: '',
      page_age: '',
    },
  ]);

  assert.ok(events.some((e) => e.event === 'content_block_start' && e.data?.content_block?.type === 'web_search_tool_result'));
});

test('translator supports multimodal tool_result (image + PDF), document blocks, DeferredToolPlaceholder filter, and schema sanitization', () => {
  const input = anthropicMessagesToResponsesInput([
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_mm',
          is_error: false,
          content: [
            { type: 'text', text: 'PDF file read: report.pdf' },
            {
              type: 'document',
              title: 'report.pdf',
              source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQ=' },
            },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
            },
          ],
        },
        {
          type: 'document',
          title: 'notes.txt',
          source: { type: 'base64', media_type: 'text/plain', data: Buffer.from('Plain text note').toString('base64') },
        },
      ],
    },
  ]);

  assert.equal(input[0].type, 'function_call_output');
  assert.deepEqual(input[0].output, [
    { type: 'input_text', text: 'PDF file read: report.pdf' },
    { type: 'input_file', filename: 'report.pdf', file_data: 'data:application/pdf;base64,JVBERi0xLjQ=' },
    { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
  ]);
  assert.equal(input[1].type, 'message');
  assert.deepEqual(input[1].content, [{ type: 'input_text', text: 'Plain text note' }]);

  const tools = anthropicToolsToResponsesTools([
    { type: 'custom', name: 'DeferredToolPlaceholder', defer_loading: true },
    {
      name: 'McpComplex',
      input_schema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          tags: { type: 'array' },
          nested: { type: 'object' },
        },
      },
    },
  ]);

  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'McpComplex');
  assert.deepEqual(tools[0].parameters.properties.tags, { type: 'array', items: {} });
  assert.deepEqual(tools[0].parameters.properties.nested, { type: 'object', properties: {} });
});

test('buildResponsesPayload maps output_config.effort, thinking.disabled/summary, per-model clamping, and cache_read_input_tokens', () => {
  const modelCatalog = [
    { slug: 'gpt-6.1-sol', supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    { slug: 'gpt-6-luna', supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  ];
  const tiers = { default: 'gpt-6.1-sol', opus: 'gpt-6-astra', sonnet: 'gpt-6.1-sol', haiku: 'gpt-6-luna' };

  assert.equal(clampReasoningEffort('ultra', ['low', 'medium', 'high', 'xhigh', 'max']), 'max');

  // Claude /effort override + thinking updates summary
  const withOutputCfg = buildResponsesPayload(
    {
      model: 'sonnet',
      thinking: { type: 'adaptive', display: 'updates' },
      output_config: { effort: 'max' },
      messages: [{ role: 'user', content: 'hi' }],
    },
    { modelTiers: tiers, reasoningEffort: 'medium', modelCatalog, effortPinned: true }
  );
  assert.deepEqual(withOutputCfg.reasoning, { effort: 'max', summary: 'auto' });

  // Haiku (`gpt-6-luna`) clamps pinned `ultra` down to `max` instead of failing HTTP 400
  const clampedHaiku = buildResponsesPayload(
    {
      model: 'haiku',
      thinking: { type: 'adaptive', display: 'updates' },
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'hi' }],
    },
    { modelTiers: tiers, reasoningEffort: 'ultra', modelCatalog, effortPinned: true }
  );
  assert.equal(clampedHaiku.model, 'gpt-6-luna');
  assert.deepEqual(clampedHaiku.reasoning, { effort: 'max', summary: 'auto' });

  // Explicit thinking disabled forces effort=none and skips summary
  const disabledThinking = buildResponsesPayload(
    {
      model: 'sonnet',
      thinking: { type: 'disabled' },
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'classify' }],
    },
    { modelTiers: tiers, reasoningEffort: 'high', modelCatalog, effortPinned: true }
  );
  assert.deepEqual(disabledThinking.reasoning, { effort: 'none' });

  // Usage splits cached tokens cleanly for Anthropic cache_read_input_tokens while keeping total in usageDetails
  const conv = new ResponsesToAnthropicConverter('gpt-6.1-sol');
  conv.processEvent({
    event: 'response.completed',
    data: {
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 1000,
          input_tokens_details: { cached_tokens: 750 },
          output_tokens: 50,
          total_tokens: 1050,
        },
      },
    },
  });
  assert.deepEqual(conv.usage, {
    input_tokens: 250,
    output_tokens: 50,
    cache_read_input_tokens: 750,
  });
  assert.equal(conv.usageDetails.inputTokens, 1000);
});

test('callOpenAIResponsesStream degrades summary-only or multimodal tool_result 400 errors cleanly', async () => {
  const seenBodies = [];
  const res = await callOpenAIResponsesStream({
    apiBaseUrl: 'https://api.openai.com/v1',
    accessToken: 'tok',
    payload: {
      model: 'gpt-6-luna',
      reasoning: { effort: 'max', summary: 'auto' },
      input: [
        {
          type: 'function_call_output',
          call_id: 'c1',
          output: [
            { type: 'input_text', text: 'See image:' },
            { type: 'input_image', image_url: 'data:image/png;base64,AA==' },
          ],
        },
      ],
      stream: true,
      store: false,
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      seenBodies.push(body);
      if (body.reasoning?.summary) {
        return new Response(JSON.stringify({ error: { message: 'Unsupported parameter: reasoning.summary' } }), { status: 400 });
      }
      if (Array.isArray(body.input?.[0]?.output)) {
        return new Response(JSON.stringify({ error: { message: 'Invalid function_call_output input_image' } }), { status: 400 });
      }
      return new Response('event: response.completed\ndata: {"type":"response.completed","response":{}}\n\n', { status: 200 });
    },
  });

  assert.equal(res.status, 200);
  assert.equal(seenBodies.length, 3);
  assert.deepEqual(seenBodies[1].reasoning, { effort: 'max' });
  assert.equal(typeof seenBodies[2].input[0].output, 'string');
  assert.match(seenBodies[2].input[0].output, /See image:/);
});

test('anthropicMessagesToResponsesInput reconciles orphaned tool results and interrupted tool calls when enabled', () => {
  const messages = [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call_done', name: 'Read', input: { file_path: 'a.js' } },
        { type: 'tool_use', id: 'call_aborted', name: 'Bash', input: { command: 'sleep 10' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_done', content: 'ok' },
        { type: 'tool_result', tool_use_id: 'call_orphan', is_error: true, content: 'stale output' },
        { type: 'text', text: 'Continue cleanly' },
      ],
    },
  ];
  const input = anthropicMessagesToResponsesInput(messages, { reconcile: true });
  const payload = buildResponsesPayload({ model: 'gpt-6.1-sol', messages });
  assert.deepEqual(payload.input, input);

  const callOutputs = input.filter((item) => item?.type === 'function_call_output');
  assert.equal(callOutputs.length, 2);
  assert.deepEqual(callOutputs[0], {
    type: 'function_call_output',
    call_id: 'call_done',
    output: 'ok',
  });
  assert.equal(callOutputs[1].call_id, 'call_aborted');
  assert.match(callOutputs[1].output, /interrupted or cancelled/i);

  const orphanMsg = input.find(
    (item) =>
      item?.type === 'message' &&
      Array.isArray(item.content) &&
      item.content.some((part) => typeof part?.text === 'string' && part.text.includes('stale output'))
  );
  assert.ok(orphanMsg, 'orphaned tool_result should be preserved as plain user text');
  assert.equal(
    callOutputs.some((item) => item.call_id === 'call_orphan'),
    false
  );
});

test('ResponsesToAnthropicConverter separates reasoning paragraphs and emits {} for zero-arg tool calls', () => {
  const conv = new ResponsesToAnthropicConverter('gpt-6.1-sol');
  const events = [
    ...conv.startEvents(),
    ...conv.processEvent({
      event: 'response.reasoning_summary_text.delta',
      data: { type: 'response.reasoning_summary_text.delta', delta: 'First part.' },
    }),
    ...conv.processEvent({
      event: 'response.reasoning_summary_part.added',
      data: { type: 'response.reasoning_summary_part.added', part: { type: 'summary_text', text: '' } },
    }),
    ...conv.processEvent({
      event: 'response.reasoning_summary_text.delta',
      data: { type: 'response.reasoning_summary_text.delta', delta: 'Second part.' },
    }),
    ...conv.processEvent({
      event: 'response.output_item.added',
      data: {
        type: 'response.output_item.added',
        output_index: 1,
        item: { id: 'fc_empty', call_id: 'call_empty', type: 'function_call', name: 'Ping', arguments: '' },
      },
    }),
    ...conv.processEvent({
      event: 'response.function_call_arguments.done',
      data: {
        type: 'response.function_call_arguments.done',
        item_id: 'fc_empty',
        output_index: 1,
        arguments: '',
      },
    }),
    ...conv.processEvent({
      event: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        output_index: 1,
        item: { id: 'fc_empty', call_id: 'call_empty', type: 'function_call', name: 'Ping', arguments: '' },
      },
    }),
    ...conv.processEvent({
      event: 'response.completed',
      data: { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
    }),
  ];

  const finalMsg = conv.toAnthropicMessage();
  assert.deepEqual(finalMsg.content[0], {
    type: 'thinking',
    thinking: 'First part.\n\nSecond part.',
  });
  assert.deepEqual(finalMsg.content[1], {
    type: 'tool_use',
    id: 'call_empty',
    name: 'Ping',
    input: {},
  });

  const inputJsonDeltas = events.filter(
    (e) => e.event === 'content_block_delta' && e.data?.delta?.type === 'input_json_delta'
  );
  assert.equal(inputJsonDeltas.length, 1);
  assert.equal(inputJsonDeltas[0].data.delta.partial_json, '{}');
});

test('buildResponsesPayload lets output_config.effort step down from xhigh while keeping ultra pinned', () => {
  const steppedDown = buildResponsesPayload(
    {
      model: 'gpt-6.1-sol',
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'hi' }],
    },
    { reasoningEffort: 'xhigh', effortPinned: true }
  );
  assert.deepEqual(steppedDown.reasoning, { effort: 'high' });

  const pinnedUltra = buildResponsesPayload(
    {
      model: 'gpt-6.1-sol',
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'hi' }],
    },
    { reasoningEffort: 'ultra', effortPinned: true }
  );
  assert.deepEqual(pinnedUltra.reasoning, { effort: 'ultra' });
});

test('callOpenAIResponsesStream recovers from 400 rejecting reasoning effort none', async () => {
  const seenBodies = [];
  const res = await callOpenAIResponsesStream({
    auth: { accessToken: 'tok', accountId: 'acct_1' },
    payload: {
      model: 'gpt-6.1-sol',
      reasoning: { effort: 'none' },
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      seenBodies.push(body);
      if (seenBodies.length === 1) {
        return new Response(
          JSON.stringify({ error: { message: "Unsupported value: 'none' is not supported." } }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('event: response.completed\ndata: {"type":"response.completed","response":{}}\n\n', {
        status: 200,
      });
    },
  });

  assert.equal(res.status, 200);
  assert.equal(seenBodies.length, 2);
  assert.equal(seenBodies[0].reasoning.effort, 'none');
  assert.notEqual(seenBodies[1].reasoning?.effort, 'none');
});
