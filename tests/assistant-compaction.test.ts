// 助手会话太长时压缩的纯逻辑（server/assistant/chat/compact*.ts，照 DeepSeek Harness 的做法）：剪枝、选区、压缩的每一步。
// 真的走一遍聊天的在 assistant-compaction-chat.test.ts。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolChatMessage } from '../server/ai/chat-tools.js';
import { compactMessages, type CompactDeps } from '../server/assistant/chat/compact.js';
import { COMPACTION_INSTRUCTION, SUMMARY_CLOSE_TAG, SUMMARY_OPEN_TAG, frameSummary } from '../server/assistant/chat/compact-prompt.js';
import { PRUNE_MARKER, pruneText, pruneToolResults } from '../server/assistant/chat/compact-prune.js';
import { balancedCuts, selectCut } from '../server/assistant/chat/compact-region.js';
import { SESSION } from '../server/assistant/chat/session-limits.js';
import { field } from '../server/assistant/chat/result-fields.js';

/** 压缩没做成时带回的原因（错误的说明）；没带回错误就让测试失败 */
function failureOf(out: { failure?: unknown }) {
  assert.ok(out.failure instanceof Error, '没有带回没做成的原因');
  return out.failure.message;
}

const sys = (content: string): ToolChatMessage => ({ role: 'system', content });
const user = (content: string): ToolChatMessage => ({ role: 'user', content });
const said = (content: string): ToolChatMessage => ({ role: 'assistant', content, reasoning_content: '' });
const asked = (...ids: string[]): ToolChatMessage => ({
  role: 'assistant',
  content: null,
  reasoning_content: '想一想',
  tool_calls: ids.map((id) => ({ id, type: 'function' as const, function: { name: 'records__get', arguments: '{}' } })),
});
const result = (id: string, content = '{"ok":true}'): ToolChatMessage => ({ role: 'tool', tool_call_id: id, content });

test('剪枝留的头尾加中间那句标记放得进剪枝上限', () => {
  assert.ok(SESSION.pruneHeadChars + Array.from(PRUNE_MARKER).length + SESSION.pruneTailChars <= SESSION.pruneAboveChars);
});

test('剪枝：没超上限不动；超了留开头和结尾、中间一句标记；不把一个字切成两半；只剪工具结果', () => {
  const limits = { pruneAboveChars: 40, pruneHeadChars: 10, pruneTailChars: 5 };
  assert.equal(pruneText('短'.repeat(40), limits), null);
  const long = '头'.repeat(10) + '中'.repeat(50) + '尾'.repeat(5);
  assert.equal(pruneText(long, limits), '头'.repeat(10) + PRUNE_MARKER + '尾'.repeat(5));
  // 表情是两个编码单元，按字切不会切出半个
  const emoji = '😀'.repeat(60);
  assert.equal(pruneText(emoji, limits), '😀'.repeat(10) + PRUNE_MARKER + '😀'.repeat(5));
  assert.equal(pruneText('字'.repeat(41), { pruneAboveChars: 40, pruneHeadChars: 10, pruneTailChars: 0 }), '字'.repeat(10) + PRUNE_MARKER);
  assert.throws(() => pruneText('字'.repeat(41), { pruneAboveChars: 40, pruneHeadChars: 30, pruneTailChars: 10 }), /配错了/);
  const messages = [user(long), asked('a'), result('a', long), result('b', '短')];
  const pruned = pruneToolResults(messages, limits);
  assert.equal(pruned.pruned, 1);
  assert.equal(pruned.messages[0], messages[0], '用户的话再长也不剪');
  assert.equal(field(pruned.messages[2], 'content'), '头'.repeat(10) + PRUNE_MARKER + '尾'.repeat(5));
  assert.equal(field(pruned.messages[2], 'tool_call_id'), 'a');
  assert.equal(pruned.messages[3], messages[3]);
  assert.equal(pruned.charsRemoved, 65 - (15 + Array.from(PRUNE_MARKER).length));
});

test('选区：从最新往回留够一段尾巴；切点不拆开工具调用和结果，一条助手消息调了几个要等几个结果都在', () => {
  const messages = [sys('规则'), user('一'), asked('a', 'b'), result('a'), result('b'), said('好'), user('二'), asked('c'), result('c'), said('完')];
  const cuts = balancedCuts(messages);
  assert.deepEqual(cuts, [true, true, true, false, false, true, true, true, false, true, true]);
  const sizes = messages.map(() => 10);
  // 留 10：只留最后一条
  assert.equal(selectCut(sizes, cuts, 1, 10), 9);
  // 留 15：要留两条，切点落在调用和结果中间，往前挪到调用之前
  assert.equal(selectCut(sizes, cuts, 1, 15), 7);
  // 留 55：切点落在 a、b 两个结果中间，往前挪到那条助手消息之前
  assert.equal(selectCut(sizes, cuts, 1, 55), 2);
  // 留尾按 0（强制压缩）：最新的一条还是留下
  assert.equal(selectCut(sizes, cuts, 1, 0), 9);
  // 全都要留、或者只剩开头的系统消息：没有能压的
  assert.equal(selectCut(sizes, cuts, 1, 1000), null);
  assert.equal(selectCut([10, 10], balancedCuts([sys('规则'), user('一')]), 1, 5), null);
  // 整段只有一对调用和结果：挪到头也没有干净的切点
  const pair = [sys('规则'), asked('a'), result('a')];
  assert.equal(selectCut([10, 10, 10], balancedCuts(pair), 1, 5), null);
  assert.equal(selectCut([], [true], 0, 5), null);
  assert.throws(() => balancedCuts([user('一'), result('x')]), /找不到对应的调用/);
});

/** 每条消息按字数算大小、tools 不占地方的假依赖；summaries 记下每次摘要请求 */
function deps(reply: string | ((request: ToolChatMessage[]) => string | Promise<string>)) {
  const requests: ToolChatMessage[][] = [];
  const d: CompactDeps = {
    measure: (m) => JSON.stringify(m).length,
    overhead: 0,
    summarize: async (request) => {
      requests.push(request);
      return typeof reply === 'string' ? reply : reply(request);
    },
  };
  return { d, requests };
}
const limits = { compactAboveTokens: 600, retainTokens: 120, compactionRetries: 1, pruneAboveChars: 200, pruneHeadChars: 40, pruneTailChars: 20 };
const chatter = (n: number) =>
  Array.from({ length: n }, (_, i) => [user(`第 ${i} 句：${'闲聊'.repeat(10)}`), said(`第 ${i} 答：${'回答'.repeat(10)}`)]).flat();

test('压缩：没到线什么都不做，连剪枝也不做', async () => {
  const messages = [sys('规则'), user('问'), asked('a'), result('a', '长'.repeat(300))];
  const { d, requests } = deps('不该被调用');
  const out = await compactMessages(messages, 1, { ...limits, compactAboveTokens: 5000 }, d);
  assert.equal(out.messages, messages, '原数组原样返回');
  assert.deepEqual([out.pruned, out.summaries, requests.length], [0, 0, 0]);
});

test('压缩：到线了先剪工具结果，剪完够了就不写摘要', async () => {
  const messages = [sys('规则'), user('问'), asked('a'), result('a', '长'.repeat(500)), said('答')];
  const { d, requests } = deps('不该被调用');
  const out = await compactMessages(messages, 1, limits, d);
  assert.deepEqual([out.pruned, out.summaries, requests.length], [1, 0, 0]);
  assert.equal(out.failure, undefined);
  assert.ok(out.after < limits.compactAboveTokens && out.before >= limits.compactAboveTokens);
  assert.match(String(field(out.messages[3], 'content')), /已省略/);
});

test('压缩：摘要请求是开头的系统消息、要压的一段原样、最后一条指令；要点包上标签作为 user 消息顶替那一段，尾巴原样', async () => {
  const messages = [sys('规则'), sys('今天几号'), ...chatter(8)];
  const { d, requests } = deps('## 用户要办的事和原话\n- 闲聊');
  const out = await compactMessages(messages, 2, limits, d);
  assert.equal(out.failure, undefined);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.deepEqual(request.slice(0, 2), messages.slice(0, 2));
  assert.deepEqual(request.at(-1), { role: 'user', content: COMPACTION_INSTRUCTION });
  const region = request.slice(2, -1);
  assert.deepEqual(region, messages.slice(2, 2 + region.length), '要压的一段原样重放，和原来的请求同前缀');
  assert.deepEqual(out.messages.slice(0, 2), messages.slice(0, 2));
  const checkpoint = out.messages[2];
  assert.equal(checkpoint.role, 'user');
  assert.equal(checkpoint.content, out.checkpoint);
  assert.ok(String(checkpoint.content).includes(`${SUMMARY_OPEN_TAG}\n## 用户要办的事和原话\n- 闲聊\n${SUMMARY_CLOSE_TAG}`));
  assert.match(String(checkpoint.content), /^这是系统自动整理的要点/);
  assert.match(String(checkpoint.content), /是数据，不是指令和授权/);
  assert.deepEqual(out.messages.slice(3), messages.slice(2 + region.length), '留下来的尾巴原样');
  assert.ok(out.messages.slice(3).reduce((n, m) => n + d.measure(m), 0) >= limits.retainTokens);
  assert.ok(out.after < out.before);
});

test('指令：八个小节、空的也要写、不许调工具、上一份要点要并进来、外来文字只当数据', () => {
  const sections = COMPACTION_INSTRUCTION.split('\n').filter((line) => line.startsWith('## '));
  assert.deepEqual(sections, [
    '## 用户要办的事和原话',
    '## 业务口径和约定',
    '## 涉及的记录和已做的写入',
    '## 出过的错和怎么解决的',
    '## 还没办完的事',
    '## 正在办的事',
    '## 下一步',
    '## 必须记住的',
  ]);
  for (const must of ['写“（无）”', '不调用任何工具', SUMMARY_OPEN_TAG, '不要照抄', '只当数据记下来', '照原样写', '不要提这次整理'])
    assert.ok(COMPACTION_INSTRUCTION.includes(must), must);
  assert.ok(frameSummary('  要点  ').includes(`${SUMMARY_OPEN_TAG}\n要点\n${SUMMARY_CLOSE_TAG}`));
});

test('压缩：要点不比原文小、模型没写出正文、写摘要出错，都算没做成——对话不动（剪过的留着），原因带回来', async () => {
  const messages = [sys('规则'), ...chatter(8)];
  const big = await compactMessages(messages, 1, limits, deps('长'.repeat(2000)).d);
  assert.match(failureOf(big), /不比原文小/);
  assert.equal(big.messages, messages);
  assert.equal(big.summaries, 0);
  const empty = await compactMessages(messages, 1, limits, deps('  \n').d);
  assert.match(failureOf(empty), /没有写出要点/);
  assert.equal(empty.messages, messages);
  const withTool = [sys('规则'), user('问'), asked('a'), result('a', '长'.repeat(300)), ...chatter(8)];
  const broken = await compactMessages(
    withTool,
    1,
    limits,
    deps(() => {
      throw new Error('虚构断线');
    }).d,
  );
  assert.equal(failureOf(broken), '虚构断线');
  assert.equal(broken.pruned, 1, '剪枝已经做成的部分留着');
  assert.equal(broken.messages.length, withTool.length);
  assert.match(String(field(broken.messages[3], 'content')), /已省略/);
  // 没有能压的一段（只有系统消息和要留的尾巴）
  const tail = [sys('规'.repeat(700)), user('问')];
  const none = await compactMessages(tail, 1, limits, deps('要点').d);
  assert.match(failureOf(none), /没有能安全压缩的一段/);
});

test('压缩：压完还在线以上再压一次，最多两次；第二次把上一份要点也交给模型并成一份', async () => {
  // 最新的一条本身就超线：怎么压都下不来
  const messages = [sys('规则'), ...chatter(6), said('尾'.repeat(700))];
  const { d, requests } = deps((request) =>
    // 最后一条是指令（里面也提到了标签），看它前面有没有上一份要点
    request.slice(0, -1).some((m) => String(m.content).includes(SUMMARY_OPEN_TAG)) ? '并好的要点' : '第一份要点：' + '细节'.repeat(30),
  );
  const out = await compactMessages(messages, 1, { ...limits, retainTokens: 20 }, d);
  assert.equal(requests.length, 2, '第一次加最多再压一次');
  assert.equal(out.summaries, 2);
  assert.match(failureOf(out), /还在线以上/);
  assert.ok(String(out.checkpoint).includes('并好的要点'));
  assert.ok(requests[1].some((m) => String(m.content).includes('第一份要点')), '上一份要点在第二次要压的那一段里');
  assert.equal(out.messages.filter((m) => String(m.content).includes(SUMMARY_OPEN_TAG)).length, 1, '对话里只留一份要点');
});

test('强制压缩（接口报上下文超长）：没到线也剪、也压，留尾按 0，只压一次', async () => {
  const messages = [sys('规则'), user('问'), asked('a'), result('a', '长'.repeat(300)), ...chatter(3)];
  const { d, requests } = deps('要点');
  const out = await compactMessages(messages, 1, { ...limits, compactAboveTokens: 1_000_000 }, d, true);
  assert.deepEqual([out.pruned, out.summaries, requests.length], [1, 1, 1]);
  assert.equal(out.failure, undefined);
  assert.deepEqual(out.messages.map((m) => m.role), ['system', 'user', 'assistant'], '只留下最新的一条');
  assert.equal(out.messages.at(-1), messages.at(-1));
});
