// 命令怎么发给模型（server/assistant/chat/command-tools.ts）：常用的十二条作为原生工具直接调，其余常驻一份目录、用三个通用工具找、查用法、执行；
// 两条路走同一条分派（只读直接执行、写入出卡片、权限照旧），经 run_command 执行时参数不对报错里带正确用法。假 DeepSeek、内存库、虚构数据。
import { sales } from '../server/sales/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assistantFixture } from './assistant-fixture.js';
import { toolResultSent } from './fake-deepseek.js';
import type { ChatBody } from './fake-deepseek-wire.js';
import { commonCommands } from '../server/assistant/command-directory.js';
import { customerSchema } from '../shared/core/domain.js';
import { actor } from './actor-fixture.js';
import { readAs } from './read-result.js';

const say = (f: ReturnType<typeof assistantFixture>, threadId: string, text: string) =>
  f.manager.chat(threadId, f.input(text, randomUUID()), actor, 's', () => {}, () => actor);
const directory = (body: ChatBody) => String(body.messages.find((m) => m.role === 'system' && String(m.content).startsWith('# 命令目录'))?.content ?? '');
function toolNames(body: ChatBody) {
  assert.ok(body.tools);
  return body.tools.map((t) => t.function?.name);
}
async function replyTo(f: ReturnType<typeof assistantFixture>, threadId: string, text: string) {
  const reply = (await say(f, threadId, text)).messages.at(-1);
  assert.ok(reply);
  return reply;
}

test('常用命令直接调，冷门命令找到、查过用法再执行：只读直接执行，写入出卡片；找命令、查用法不算办事', async () => {
  const f = assistantFixture();
  try {
    const c = sales(f.store).createCustomer(customerSchema.parse({ name: '虚构目录客户甲' }));
    f.replies.push(
      { message: '', toolCalls: [{ name: 'records.get', args: { module: 'customers', id: c.id } }] },
      { message: '', toolCalls: [{ name: 'find_command', args: { query: '修改历史' } }] },
      { message: '', toolCalls: [{ name: 'command_usage', args: { names: ['history.records', 'no.such'] } }] },
      { message: '', toolCalls: [{ name: 'history.records', args: { module: 'customers', id: c.id } }] },
      { message: '', toolCalls: [{ name: 'records.propose_save', args: { module: 'customers', id: c.id, patch: { phone: '0574-1234' } } }] },
      { message: '查到了客户，出了改电话的卡片。' },
    );
    const t = f.manager.create(actor);
    const reply = await replyTo(f, t.id, '把虚构目录客户甲的电话改成 0574-1234');
    const first = f.requests[0].body;
    // 常用的十二条里这个账号能用的作为原生工具给（带参数结构），后面是三个通用工具
    const given = toolNames(first);
    assert.deepEqual(given.slice(-3), ['find_command', 'command_usage', 'run_command']);
    assert.deepEqual(
      given.slice(0, -3).sort(),
      commonCommands.filter((n) => f.manager.registry.exposed(actor).some((x) => x.name === n)).map((n) => n.split('.').join('__')).sort(),
    );
    assert.ok(first.tools?.[0].function?.parameters?.properties, '原生工具带参数结构');
    // 目录只列没有直接给的命令，每条一行，不印用法
    assert.match(directory(first), /\nhistory\.records：/);
    for (const name of commonCommands) assert.ok(!directory(first).includes('\n' + name + '：'), name + ' 不在目录里重复');
    assert.doesNotMatch(directory(first), /### |参数：/);
    // 模型实际怎么调的：常用的直接调，冷门的经 run_command
    const last = f.requests.at(-1);
    assert.ok(last);
    const asked = last.body.messages.flatMap((m) => m.tool_calls ?? []).map((x) => x.function?.name);
    assert.deepEqual(asked, ['records__get', 'find_command', 'command_usage', 'run_command', 'records__propose_save']);
    // 找命令、查用法：当场给结果
    const calls = f.requests;
    assert.ok(readAs(toolResultSent(calls, 'find_command'), { 命令: z.array(z.looseObject({ name: z.unknown() })) }).命令.some((x) => x.name === 'history.records'));
    const usage = readAs(toolResultSent(calls, 'command_usage'), { 用法: z.string() }).用法;
    assert.match(usage, /### history\.records\n/);
    assert.match(usage, /### no\.such\n没有这条命令/);
    // 只读直接执行，写入只出卡片
    assert.equal(readAs(toolResultSent(calls, 'records.get'), { record: z.looseObject({ name: z.unknown() }) }).record.name, '虚构目录客户甲');
    assert.notEqual(readAs(toolResultSent(calls, 'history.records'), { ok: z.unknown().optional() }).ok, false);
    assert.equal(readAs(toolResultSent(calls, 'records.propose_save'), { state: z.unknown() }).state, 'awaiting_confirmation');
    assert.equal(sales(f.store).customer(c.id)?.phone, '');
    assert.deepEqual(reply.facts?.tools, ['records.get', 'history.records', 'records.propose_save'], '找命令、查用法不记进这一轮办的事');
    assert.equal(reply.facts?.reads, 2);
    assert.equal(reply.facts?.cards.length, 1);
    assert.equal(reply.plans?.[0].module, 'customers', '卡片是哪个模块由服务器给');
  } finally {
    f.close();
  }
});

test('执行命令时参数不对：报错里带上这条命令的正确用法，模型照着改，不用再查一次', async () => {
  const f = assistantFixture();
  try {
    f.replies.push(
      { message: '', toolCalls: [{ name: 'history.records', args: { 不认识的参数: 1 } }] },
      { message: '参数写错了。' },
    );
    const t = f.manager.create(actor);
    const reply = await replyTo(f, t.id, '看看修改历史');
    const failed = readAs(toolResultSent(f.requests, 'history.records'), { ok: z.unknown(), message: z.string() });
    assert.equal(failed.ok, false);
    assert.match(failed.message, /^参数不对：/);
    assert.match(failed.message, /正确用法：\n### history\.records\n/);
    assert.match(failed.message, /参数：\{/);
    assert.equal(reply.facts?.failed.length, 1);
  } finally {
    f.close();
  }
});

test('常用命令经 run_command 调也照样执行；只有这一种给法，没有换档的开关', async () => {
  const f = assistantFixture();
  try {
    const c = sales(f.store).createCustomer(customerSchema.parse({ name: '虚构目录客户乙' }));
    f.replies.push({ message: '', toolCalls: [{ name: 'run_command', args: { name: 'records.get', args: { module: 'customers', id: c.id } } }] }, { message: '查到了。' });
    const t = f.manager.create(actor);
    const reply = await replyTo(f, t.id, '看看虚构目录客户乙');
    assert.deepEqual(reply.facts?.tools, ['records.get']);
    assert.equal(readAs(toolResultSent(f.requests, 'records.get'), { record: z.looseObject({ name: z.unknown() }) }).record.name, '虚构目录客户乙');
    assert.deepEqual(Object.keys(f.manager.agent).sort(), ['autoConfirm', 'session']);
  } finally {
    f.close();
  }
});
