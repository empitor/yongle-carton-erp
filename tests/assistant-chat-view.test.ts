// 助手聊天窗口的前端纯函数：确认卡片上的说法和按钮（plan-card.ts）、分事件（chat-stream.ts；读流见 stream-reply.test.ts）、
// 会话数据（thread-view.ts）。不起服务。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardState, executedItems, factLines, planCardButton, planCardNote, planConfirmButton, reviewNotes } from '../src/assistant/plan-card.js';
import {
  appendReasoning,
  chatFailureText,
  chatProgressText,
  countThinking,
  partialAlreadySaved,
  reasoningChars,
  reasoningText,
  replyFollowUps,
  routeChatEvent,
} from '../src/assistant/chat-stream.js';
import type { ChatEventHandlers } from '../src/assistant/chat-stream.js';
import { findPlan, isNewReply, replyCue, syncedReview, withUserMessage } from '../src/assistant/thread-view.js';

test('助手确认卡片的说法：按服务器给的标记和卡片状态写；删除按钮红色实心写“确认删除”；事实那一行不露英文工具名和报错原文；忘掉记忆后那一项标成已忘掉', () => {
  const now = 1000;
  // 待送货的送货单：不要密码，也不提超级管理员模式
  const draft = planCardNote({ tool: 'records.delete', destructive: true, highRisk: true, requiresPassword: false, requiresSuperMode: false }, now);
  assert.equal(draft, '删除后不能恢复 · 核对后点确认才执行');
  assert.doesNotMatch(draft, /密码|超级|二次确认/);
  // 已核对的单据、档案，不在本机：超级管理员模式下输本人密码
  assert.equal(
    planCardNote({ tool: 'records.delete', destructive: true, highRisk: true, requiresPassword: true, requiresSuperMode: true }, now),
    '删除后不能恢复 · 超级管理员模式下输本人密码确认',
  );
  assert.match(planCardNote({ tool: 'management.reset', destructive: true, highRisk: true, localOnly: true }, now), /^清空后不能恢复/);
  assert.equal(planCardNote({ tool: 'flow.propose_reversal', highRisk: true }, now), '影响较大 · 核对后点确认才执行');
  // 卡片的状态由服务器标：执行了、作废了（人点了不执行）、过期了各有说法，都不再放按钮
  assert.equal(planCardNote({ tool: 'records.delete', destructive: true, state: 'executed' }, now), '已执行');
  assert.equal(planCardNote({ state: 'cancelled' }, now), '没有执行（已作废）');
  assert.equal(planCardNote({ state: 'expired' }, now), '已过期，没有执行');
  assert.equal(planCardButton({ id: 'p1', state: 'executed', expiresAt: 2000 }, now), null);
  assert.equal(planCardButton({ id: 'p1', state: 'cancelled', expiresAt: 2000 }, now), null);
  assert.deepEqual(planCardButton({ id: 'p1', state: 'waiting', expiresAt: 2000 }, now), { label: '查看修改内容并确认' });
  // 页面开着的时候过了有效期：也按过期
  assert.equal(planCardButton({ id: 'p1', state: 'waiting', expiresAt: 2000 }, 3000), null);
  assert.equal(cardState({ id: 'p1', state: 'waiting', expiresAt: 2000 }, 3000), 'expired');
  assert.deepEqual(planConfirmButton({ tool: 'records.delete', destructive: true }), {
    label: '确认删除',
    className: 'danger-solid',
    passwordLabel: '输入本人密码确认删除',
  });
  assert.deepEqual(planConfirmButton({ tool: 'management.reset', destructive: true }), {
    label: '确认清空',
    className: 'danger-solid',
    passwordLabel: '输入本人密码确认清空',
  });
  assert.equal(planConfirmButton({ tool: 'flow.propose_reversal', highRisk: true }).label, '确认执行');
  assert.equal(planConfirmButton({ tool: 'flow.propose_reversal', highRisk: true }).className, 'primary');
  // 核对区的固定提醒：删除说删除、清空说清空；删除记录的方案说删前留快照
  assert.deepEqual(reviewNotes({ tool: 'records.delete', destructive: true, after: { impact: [] } }), [
    '删除后不能恢复。助手不会自动执行，需要你在这里确认。',
    '删除前系统会自动留一份恢复快照。',
  ]);
  assert.deepEqual(reviewNotes({ tool: 'management.reset', destructive: true, after: {} }), ['清空后不能恢复。助手不会自动执行，需要你在这里确认。']);
  assert.deepEqual(reviewNotes({ tool: 'flow.propose_reversal', highRisk: true }), []);
  // 每条回复下面固定的一行：这一轮服务器实际做了什么
  const facts = (over: object) => ({ tools: [], reads: 0, cards: [], executed: [], failed: [], ...over });
  assert.deepEqual(factLines(undefined, undefined, now).map((l) => l.text), []);
  assert.deepEqual(factLines(facts({}), [], now).map((l) => l.text), [], '纯聊天不写');
  assert.deepEqual(factLines(facts({ reads: 3 }), [], now).map((l) => l.text), ['只查询，没有改动']);
  const cards = [{ id: 'p1', label: '删除采购单 CG-20261101-0001' }];
  assert.deepEqual(factLines(facts({ reads: 1, cards }), [{ id: 'p1', state: 'waiting' }], now).map((l) => l.text), ['待确认：删除采购单 CG-20261101-0001']);
  assert.deepEqual(factLines(facts({ cards }), [{ id: 'p1', state: 'executed' }], now).map((l) => l.text), ['已确认执行：删除采购单 CG-20261101-0001']);
  assert.deepEqual(factLines(facts({ cards }), [{ id: 'p1', state: 'cancelled' }], now).map((l) => l.text), ['没有执行：删除采购单 CG-20261101-0001']);
  assert.deepEqual(
    factLines(facts({ executed: [{ label: '识别订单文件' }], failed: [{ label: '查业务记录', message: 'records.search: filters.q Invalid input' }] }), [], now).map((l) => l.text),
    ['已执行：识别订单文件', '没做成：查业务记录'],
  );
  // “已执行”那一行里，助手自己记下、改过的长期记忆后面有“忘掉”；忘掉以后那一项写“已忘掉”，不再给按钮；别的事没有按钮
  const remembered = [{ label: '识别订单文件' }, { label: '已记住：虚构客户甲按含税', memoryId: 7 }, { label: '已改记忆：大箱指 A-100 → 大箱指 A-200', memoryId: 8 }];
  assert.deepEqual(factLines(facts({ executed: remembered }), [], now)[0].executed, remembered, '这一行带着各项，页面按项画');
  assert.deepEqual(executedItems(remembered), [
    { text: '识别订单文件' },
    { text: '已记住：虚构客户甲按含税', forget: 7 },
    { text: '已改记忆：大箱指 A-100 → 大箱指 A-200', forget: 8 },
  ]);
  // 忘掉以后原来那句留着、标成已忘掉（页面上划掉原文，后面写“已忘掉”），看得出撤的是哪一条；没忘成的写上原因、按钮还在
  assert.deepEqual(executedItems(remembered, { 7: true, 8: '虚构：网络断了' }), [
    { text: '识别订单文件' },
    { text: '已记住：虚构客户甲按含税', forgotten: true },
    { text: '已改记忆：大箱指 A-100 → 大箱指 A-200', forget: 8, note: '虚构：网络断了' },
  ]);
});

test('分事件和进度说法：每种事件只到对应的处理；思考内容按轮接上、字数按轮计', () => {
  // 分事件：每种事件只到对应的处理
  const calls: string[] = [];
  const record = (k: string) => (v: unknown) => {
    calls.push(k + ':' + JSON.stringify(v));
  };
  const on: ChatEventHandlers = {
    pageCommand: record('pageCommand'),
    effect: record('effect'),
    speaker: record('speaker'),
    draft: record('draft'),
    said: record('said'),
    progress: record('progress'),
    result: record('result'),
    error: record('error'),
    reasoning: record('reasoning'),
    modelProgress: record('modelProgress'),
  };
  routeChatEvent('draft', { text: '正在写' }, on);
  routeChatEvent('queue', { state: 'waiting', position: 2 }, on);
  routeChatEvent('error', { message: '模型没响应' }, on);
  routeChatEvent('page_command', { id: 'c1' }, on);
  routeChatEvent('said', { speaker: 'le', text: '我先查一下。' }, on);
  routeChatEvent('unknown', {}, on);
  assert.deepEqual(calls, ['draft:"正在写"', 'progress:"等待AI空闲连接 · 排队 2"', 'error:"模型没响应"', 'pageCommand:{"id":"c1"}', 'said:{"speaker":"le","text":"我先查一下。"}']);
  assert.equal(chatProgressText('queue', { state: 'running' }), '正在生成…');
  assert.equal(chatProgressText('queue', { state: 'backoff' }), 'API限流，退避等待中…');
  assert.equal(chatProgressText('progress', {}), '正在处理 · 0 字符');
  assert.equal(chatProgressText('tool', { state: 'running', label: '联网搜索：虚构纸价' }), '正在联网搜索：虚构纸价…');
  assert.equal(chatProgressText('tool', { state: 'completed', label: '联网搜索：虚构纸价' }), '正在整理结果…');
  assert.equal(chatProgressText('task', {}), undefined);
  assert.equal(chatProgressText('progress', { stage: 'thinking', reasoningChars: 120 }), '正在思考…');
  assert.equal(chatProgressText('progress', { stage: 'retrying', attempt: 2 }), 'AI 连接中断，正在重发（第 2 次）…');
  // 思考内容（原生工具调用）：按轮交给 reasoning；增量同一轮接上、换轮另起一段，段间空一行
  const thought: string[] = [];
  routeChatEvent('reasoning', { round: 2, text: '想一下' }, { ...on, reasoning: (round: number, text: string) => thought.push(round + ':' + text) });
  assert.deepEqual(thought, ['2:想一下']);
  // 进度里的字数按轮计：新一轮（stage: model）开始时把上一轮的并进来
  let count = { done: 0, current: 0 };
  for (const d of [{ stage: 'model', round: 1 }, { stage: 'thinking', reasoningChars: 11 }, { stage: 'thinking', reasoningChars: 21 }, { stage: 'model', round: 2 }, { stage: 'thinking', reasoningChars: 5 }, { stage: 'queue' }])
    count = countThinking(count, d);
  assert.deepEqual(count, { done: 21, current: 5 });
  let parts = appendReasoning([], 1, '先查订单');
  parts = appendReasoning(parts, 1, '，再看库存');
  parts = appendReasoning(parts, 2, '库存够了');
  assert.equal(appendReasoning(parts, 2, ''), parts, '空增量不变');
  assert.deepEqual(parts, [
    { round: 1, text: '先查订单，再看库存' },
    { round: 2, text: '库存够了' },
  ]);
  assert.equal(reasoningText(parts), '先查订单，再看库存\n\n库存够了');
  assert.equal(reasoningChars(parts), 13);
});

test('收到结果后要跟着做的事、失败的说法、半截回复已存就不再单独显示', () => {
  // 收到结果后要跟着做的事
  assert.deepEqual(replyFollowUps({ messages: [{ text: '只是回答' }] }), { businessChanged: false, workspace: null });
  assert.deepEqual(
    replyFollowUps({
      messages: [{ facts: { executed: [{ label: '改识别结果（还没导入）' }] } }],
      orderWorkflow: { activeId: 'a', tasks: [{ id: 'a', workspaceId: 'w1' }] },
    }),
    { businessChanged: true, workspace: { workspaceId: 'w1' } },
  );
  // 失败的说法
  const named = (name: string, message = '原错误') => Object.assign(new Error(message), { name });
  assert.equal(chatFailureText(named('AbortError'), true), '账号已切换，旧请求已停止。');
  assert.equal(chatFailureText(named('AbortError'), false), '已停止回复；可重新载入历史查看最终状态。');
  assert.match(chatFailureText(named('TimeoutError'), false), /^等了太久没收到回复/);
  assert.equal(chatFailureText(named('Error', '还没填写 DeepSeek 密钥。'), false), '还没填写 DeepSeek 密钥。');
  // 半截回复已经存进聊天记录（按前 40 个字找）就不再单独显示
  const saved = { messages: [{ role: 'assistant', text: '前文……虚构订单已经排产，明天送货。' }] };
  assert.equal(partialAlreadySaved(saved, '虚构订单已经排产'), true);
  assert.equal(partialAlreadySaved(saved, '别的话'), false);
  assert.equal(partialAlreadySaved(null, '虚构订单已经排产'), false);
  assert.equal(partialAlreadySaved(saved, ''), false);
});

test('聊天会话数据：先显示刚发的话、核对区换成哪一版、新回复谁说的', () => {
  const thread = {
    id: 't1',
    messages: [
      { id: 'm1', role: 'assistant', plans: [{ id: 'p1', state: 'executed', args: { module: 'orders' } }, { id: 'p2', state: 'waiting' }, { id: 'p3', state: 'cancelled' }] },
      { id: 'm2', role: 'assistant' },
    ],
  };
  const sent = withUserMessage(thread, 'm3', '虚构问题');
  assert.deepEqual(sent.messages.at(-1), { id: 'm3', role: 'user', text: '虚构问题' });
  assert.equal(thread.messages.length, 2, '原来的会话不改');
  assert.equal(findPlan(thread, 'p1')?.args?.module, 'orders');
  assert.equal(findPlan(null, 'p1'), undefined);
  // 执行过的、作废的、不在了的关掉核对区；还在等确认的换成库里这一版
  assert.equal(syncedReview(thread, 'p1'), null);
  assert.equal(syncedReview(thread, 'p3'), null);
  assert.deepEqual(syncedReview(thread, 'p2'), { id: 'p2', state: 'waiting' });
  assert.equal(syncedReview(thread, 'p9'), null);
  // 新回复：接力时按最后一段的人，只取第一行，超过 28 个字截断；认不出说话人不提示
  assert.deepEqual(replyCue({ speaker: 'yong', text: '第一行\n第二行' }), { speaker: 'yong', line: '第一行' });
  assert.deepEqual(replyCue({ speaker: 'yong', text: '开头', relay: [{ speaker: 'le', text: '小勒接着说' }] }), { speaker: 'le', line: '小勒接着说' });
  assert.equal(replyCue({ speaker: 'yong', text: '一'.repeat(30) })?.line, '一'.repeat(28) + '…');
  assert.equal(replyCue({ text: '没人说' }), null);
  // 同一会话里新来的助手回复才算；刚打开的旧会话、自己发的话、没变的不算
  const last = { id: 'm2', role: 'assistant' };
  assert.equal(isNewReply({ thread: 't1', id: 'm1' }, thread, last), true);
  assert.equal(isNewReply({}, thread, last), false);
  assert.equal(isNewReply({ thread: 't1', id: 'm2' }, thread, last), false);
  assert.equal(isNewReply({ thread: 't1', id: 'm1' }, thread, { id: 'm3', role: 'user' }), false);
});
