// 代码检查 no-flow-literals（scripts/eslint-local-rules.mjs）的样例：SQL 里写死的单据状态、种类和 flow_ 记录种类会被拦，
// 由常量拼的、参数传的、别的表的同名值不拦；规则里的词表和 shared/business 的常量一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Linter } from 'eslint';
import { localRules } from '../scripts/eslint-local-rules.mjs';
import { flowEntity, flowKinds, flowStatus } from '../shared/business/index.js';

const RULE = 'local/no-flow-literals';
const linter = new Linter({ configType: 'flat' });
const config = [{ plugins: { local: { rules: localRules } }, rules: { [RULE]: 'error' } }];

/** 一段代码里被规则拦下的条数 */
const hits = (code) => linter.verify(code, config).filter((m) => m.ruleId === RULE).length;

test('SQL 里写死单据状态、种类、带引号的 flow_ 值时被拦', () => {
  for (const code of [
    `q("SELECT 1 FROM flow_documents WHERE status='draft'");`,
    `q("SELECT 1 FROM flow_documents d WHERE d.status != 'reversed'");`,
    "q(`SELECT 1 FROM flow_documents f WHERE f.kind IN ('delivery','arrival') AND f.status IN ('confirmed','reversed')`);",
    `q("SELECT 1 FROM flow_documents WHERE kind='task' AND id=?");`,
    `q("SELECT 1 FROM stock_movements WHERE source_kind='flow_delivery'");`,
    "q(`SELECT 1 FROM stock_movements m WHERE m.source_kind='flow_'||f.kind`);",
    `q("SELECT 1 FROM record_lifecycle WHERE entity='flow_production'");`,
  ])
    assert.equal(hits(code), 1, code);
});

test('单据的记录种类写成 flow_ 字面值时被拦（拼接的前缀也算）', () => {
  for (const code of [`const e = 'flow_delivery';`, `const e = 'flow_' + kind;`, `audit({ entity: 'flow_reversal' });`])
    assert.equal(hits(code), 1, code);
});

test('由常量拼的、参数传的、表名和别的表的同名值不拦', () => {
  for (const code of [
    "q(`SELECT 1 FROM flow_documents WHERE status='${flowStatus.draft}' AND kind=${doc('task')}`);",
    "q(`SELECT 1 FROM stock_movements m WHERE m.source_kind='${flowEntityPrefix}'||f.kind`);",
    `q('SELECT 1 FROM flow_documents WHERE kind=? AND status=?', kind, flowStatus.confirmed);`,
    `q("SELECT 1 FROM flow_refs r JOIN flow_documents d ON d.id=r.document_id");`,
    `q("SELECT 1 FROM stock_items WHERE kind='finished'");`,
    `q("SELECT 1 FROM import_documents WHERE status='pending'");`,
    `if (doc.status === 'draft') go();`,
    `const table = 'flow_documents';`,
  ])
    assert.equal(hits(code), 0, code);
});

test('规则认的状态、种类和 shared/business 的常量一致：每个状态、每种单据、每个记录种类都拦得住', () => {
  for (const status of Object.values(flowStatus)) assert.equal(hits(`q("SELECT 1 FROM t WHERE status='${status}'");`), 1, status);
  for (const kind of flowKinds) {
    assert.equal(hits(`q("SELECT 1 FROM t WHERE kind='${kind}'");`), 1, kind);
    assert.equal(hits(`const e = '${flowEntity(kind)}';`), 1, flowEntity(kind));
  }
});
