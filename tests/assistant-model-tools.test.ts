// 助手发给 DeepSeek 的工具：工具转换（名字映射、参数结构裁剪）、读一条助手消息。直接调用，不起系统。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AssistantToolRegistry } from '../server/assistant/tool-registry.js';
import { buildModelTools, modelToolName, trimSchema } from '../server/assistant/chat/model-tools.js';
import { readAs } from './read-result.js';

test('发给模型的工具：目录里每个工具都能换成合法且不重名的名字，反查回原名；不另加别的工具', () => {
  const registry = new AssistantToolRegistry(':memory:', () => true);
  try {
    const tools = registry.view().tools;
    const { tools: sent, registryName } = buildModelTools(tools);
    assert.equal(sent.length, tools.length);
    for (const t of tools) {
      const name = modelToolName(t.name);
      assert.match(name, /^[a-zA-Z0-9_-]{1,128}$/, t.name);
      assert.equal(registryName.get(name), t.name);
    }
    for (const t of sent) assert.equal(t.function.parameters.type, 'object', t.function.name);
    const before = JSON.stringify(tools.map((t) => t.parameters)).length,
      after = JSON.stringify(sent.map((t) => t.function.parameters)).length;
    assert.ok(after < before * 0.75, `裁剪后 ${after} 字，裁剪前 ${before} 字`);
  } finally {
    registry.close();
  }
});

test('参数结构裁剪：去掉程序用的噪音，必填、枚举、默认值留着；字段名和关键字同名时不误删；只有几种写法的最外层补成 object', () => {
  const trimmed = trimSchema({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid', pattern: '^[0-9a-f-]+$' },
      count: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      pattern: { type: 'string', enum: ['a', 'b'], default: 'a' },
      filters: { type: 'object', propertyNames: { type: 'string' }, additionalProperties: {} },
      lines: { type: 'array', maxItems: 5, items: { type: 'object', properties: { q: { type: 'string', maxLength: 20 } }, additionalProperties: false } },
      ref: { type: 'integer', exclusiveMinimum: 0 },
    },
    required: ['id', 'pattern'],
    additionalProperties: false,
  });
  assert.deepEqual(trimmed, {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      count: { type: 'integer', minimum: 1 },
      pattern: { type: 'string', enum: ['a', 'b'], default: 'a' },
      filters: { type: 'object' },
      lines: { type: 'array', items: { type: 'object', properties: { q: { type: 'string' } } } },
      ref: { type: 'integer' },
    },
    required: ['id', 'pattern'],
  });
  assert.deepEqual(trimSchema({ anyOf: [{ type: 'object', properties: {} }] }), {
    type: 'object',
    anyOf: [{ type: 'object', properties: {} }],
  });
});

test('读模型的一条助手消息：说话人标记和接力、写错的标记不露给人、名字反查、读不懂的调用拿掉', async () => {
  const { readModelReply, readSpeakerMarks } = await import('../server/assistant/chat/model-reply.js');
  assert.deepEqual(readSpeakerMarks('【小勒】\n排好了。\n\n【小甬】\n记得通知客户。'), {
    message: '排好了。',
    speaker: 'le',
    relay: [{ speaker: 'yong', text: '记得通知客户。' }],
  });
  assert.deepEqual(readSpeakerMarks('没有标记的回答'), { message: '没有标记的回答' });
  assert.deepEqual(readSpeakerMarks('【小渝】\n查到了 3 张订单。'), { message: '查到了 3 张订单。' }, '写错的标记不认也不露');
  assert.deepEqual(readSpeakerMarks('【注意】这批货要加急'), { message: '【注意】这批货要加急' }, '别的方括号内容不动');
  const call = (id: string, name: string, args: string) => ({ id, type: 'function' as const, function: { name, arguments: args } });
  const { reply, rejected } = readModelReply(
    {
      content: '【小甬】\n我先查一下。',
      toolCalls: [
        call('a', 'records__get', '{"module":"customers","id":1}'),
        call('c', 'nope__tool', '{}'),
        call('d', 'records__get', '{不是 JSON'),
      ],
    },
    new Map([['records__get', 'records.get']]),
  );
  assert.equal(reply.speaker, 'yong');
  assert.equal(reply.message, '我先查一下。');
  assert.deepEqual(reply.calls, [{ call: { name: 'records.get', args: { module: 'customers', id: 1 } }, id: 'a' }]);
  assert.deepEqual(rejected.map((r) => r.id), ['c', 'd'], '没声明的、参数读不懂的拿掉，绝不执行');
});

test('参数结构改小：ui.open 只用 module（不再有重复的 page），order_import.edit 的修改合成一个对象，接受的写法照旧', async () => {
  const { z } = await import('zod');
  const { toolDefinitions } = await import('../server/assistant/tool-catalog.js');
  const schemaOf = (name: string) => {
    const tool = toolDefinitions.find((t) => t.name === name);
    assert.ok(tool, name);
    return tool.schema;
  };
  const open = z.toJSONSchema(schemaOf('ui.open'));
  assert.ok(open.properties);
  assert.deepEqual(Object.keys(open.properties), ['module', 'id', 'q']);
  const edit = schemaOf('order_import.edit');
  const shape = readAs(z.toJSONSchema(edit), {
    properties: z.looseObject({ operations: z.looseObject({ items: z.looseObject({ type: z.string() }) }) }),
  });
  assert.equal(shape.properties.operations.items.type, 'object', '一种写法，不是 oneOf');
  const lineId = '00000000-0000-4000-8000-000000000001';
  const ok = (op: object) => edit.safeParse({ expectedRevision: 1, operations: [{ value: '1', reason: '虚构', ...op }] }).success;
  assert.equal(ok({ op: 'set-line', lineId, field: 'quantity' }), true);
  assert.equal(ok({ op: 'set-header', field: 'buyerName' }), true);
  assert.equal(ok({ op: 'set-line', field: 'quantity' }), false, '改明细要带 lineId');
  assert.equal(ok({ op: 'set-header', lineId, field: 'buyerName' }), false, '改表头不带 lineId');
  assert.equal(ok({ op: 'set-line', lineId, field: 'buyerName' }), false, '明细没有表头字段');
  assert.equal(ok({ op: 'set-header', field: 'quantity' }), false, '表头没有明细字段');
});
