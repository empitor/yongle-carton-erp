// 出卡片前的试执行（server/assistant/tools/card-rehearsal.ts）的两道守卫：要等的函数不试；业务库里每张表要么盯着、要么写明为什么不用盯。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, count } from '../../server/core/index.js';
import type { ToolContext } from '../../server/assistant/tools/context.js';
import { PROMISE_REFUSED, rehearseChanges, rehearsedTables } from '../../server/assistant/tools/card-rehearsal.js';
import { autoConfirmAssistant, ctxOf } from '../support/assistant-fixture.js';

test('试执行拒绝要等的函数：回滚之后它接着写的会真的落库、没人确认，这类命令要登记成流程类卡片', () => {
  const f = autoConfirmAssistant();
  try {
    const tools = f.manager.tools;
    const ctx: ToolContext = { ...ctxOf(tools.store), ops: tools.ops, flow: tools.flow, tools };
    assert.throws(() => rehearseChanges(ctx, async () => 1, () => undefined), (e: unknown) => e instanceof Error && e.message === PROMISE_REFUSED);
    assert.throws(() => rehearseChanges(ctx, () => Promise.resolve(1), () => undefined), (e: unknown) => e instanceof Error && e.message === PROMISE_REFUSED);
    // 同步的照常试，试完不留触发器
    assert.equal(rehearseChanges(ctx, () => 2, () => undefined).result, 2);
    assert.equal(count(f.store.db, "SELECT COUNT(*) n FROM sqlite_temp_master WHERE type='trigger'"), 0);
  } finally {
    f.close();
  }
});

/** 不用盯的表和理由：留痕、编号计数、派生的索引和预览、别的流程自己的记录 */
const notTracked: Record<string, string> = {
  business_audit: '修改留痕，卡片上写的就是这些改动本身',
  permanent_record_deletions: '永久删除的留痕；删除有自己的卡片（删除影响）',
  operation_requests: '防重复提交的回执',
  number_sequences: '单号计数',
  schema_migrations: '库结构版本',
  sqlite_sequence: 'SQLite 自己的自增计数',
  stock_movement_revisions: '管理员改流水的修订留痕；库存净变化按 stock_movements 算',
  mark_files: '唛头文件内容；挂到哪个产品记在 product_marks（盯着）',
  document_exports: '导出记录；导出走流程类卡片',
  document_template_settings: '单据模板设置，不经助手卡片改',
  import_executions: '正式导入的回执；导入走流程类卡片',
  inbox_files: '收件箱的文件内容；收件本身记在 inbox_items（盯着）',
  flow_refs: '单据引用索引，从单据派生',
  flow_receipt_keys: '到货记录键，派生',
  flow_file_uses: '单据用到的文件引用',
  flow_sources: '单据的来源文件',
};
const prefixReasons: [string, string][] = [
  ['fin_', '财务自己读单据生成凭证和账，业务写入不同步写财务表'],
  ['assistant_', '助手自己的会话、卡片和审计'],
];

test('业务库里每张表要么在试执行盯着的名单里，要么写明为什么不用盯：新加业务表忘了登记会被拦', () => {
  const store = new Store(':memory:');
  try {
    const tracked = new Set(rehearsedTables());
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name));
    const missing = tables.filter((t) => !tracked.has(t) && !notTracked[t] && !prefixReasons.some(([p]) => t.startsWith(p)));
    assert.deepEqual(missing, [], '这些表既没有盯，也没写为什么不用盯（server/assistant/tools/card-rehearsal.ts 的 tables，或这里的 notTracked）');
    for (const t of tracked) assert.ok(tables.includes(t), '盯着的表不存在：' + t);
    for (const t of Object.keys(notTracked)) assert.ok(tables.includes(t), '登记了不用盯的表不存在：' + t);
  } finally {
    store.close();
  }
});
