// 慢测试检查（scripts/test-slow.mjs）：并行用时只挑嫌疑，按单独重跑的用时下结论。重跑用假的，不起进程、不真计时。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RERUN_FILES, checkSlow, namePattern } from '../scripts/test-slow.mjs';

const rec = (file, name, ms) => ({ file, name, ms });

/** 假重跑：按 { 文件: { 测试名: 单独用时 } } 返回记录，并记下每次重跑了哪份文件的哪几条 */
function fakeRerun(alone) {
  const calls = [];
  const rerun = async (file, names) => {
    calls.push({ file, names });
    return names.filter((n) => alone[file]?.[n] !== undefined).map((n) => rec(file, n, alone[file][n]));
  };
  return { rerun, calls };
}

async function check(records, exempt, alone) {
  const { rerun, calls } = fakeRerun(alone);
  const lines = [];
  const slow = await checkSlow(records, exempt, rerun, (l) => lines.push(l));
  return { slow, calls, text: lines.join('\n') };
}

test('并行时越线、单独跑不超 1 秒：不算慢，只提示一行', async () => {
  const r = await check([rec('tests/a.test.ts', '甲', 1150)], {}, { 'tests/a.test.ts': { 甲: 700 } });
  assert.equal(r.slow, 0);
  assert.deepEqual(r.calls, [{ file: 'tests/a.test.ts', names: ['甲'] }]);
  assert.match(r.text, /并行时越线、单独跑不慢的 1 条/);
  assert.doesNotMatch(r.text, /没登记原因/);
});

test('并行和单独都超 1 秒、没登记：算慢，列出单独跑的用时', async () => {
  const r = await check([rec('tests/a.test.ts', '甲', 1300)], {}, { 'tests/a.test.ts': { 甲: 1800 } });
  assert.equal(r.slow, 1);
  assert.match(r.text, /单独 +1\.8 秒（并行 1\.3 秒） {2}tests\/a\.test\.ts {2}甲/);
});

test('单独重跑没拿到用时的越线测试：算慢，写明没拿到', async () => {
  const r = await check([rec('tests/a.test.ts', '甲', 1300)], {}, {});
  assert.equal(r.slow, 1);
  assert.match(r.text, /单独 +没拿到/);
});

test('登记过的测试并行越线：不报、不重跑', async () => {
  const exempt = { 'tests/a.test.ts': { 甲: '原因' } };
  const r = await check([rec('tests/a.test.ts', '甲', 2500)], exempt, {});
  assert.equal(r.slow, 0);
  assert.deepEqual(r.calls, []);
  assert.match(r.text, /登记过原因的慢测试 1 条，不报/);
  assert.doesNotMatch(r.text, /删掉/);
});

test('登记过的测试并行没越线、单独也不超：提示从登记表删掉，不让命令失败', async () => {
  const exempt = { 'tests/a.test.ts': { 甲: '原因' } };
  const r = await check([rec('tests/a.test.ts', '甲', 600)], exempt, { 'tests/a.test.ts': { 甲: 500 } });
  assert.equal(r.slow, 0);
  assert.match(r.text, /从 scripts\/test-exemptions\.mjs 删掉：\n {2}tests\/a\.test\.ts {2}甲/);
});

test('登记过的测试并行没越线、单独跑超 1 秒：仍算登记过的慢测试，不提示删', async () => {
  const exempt = { 'tests/a.test.ts': { 甲: '原因' } };
  const r = await check([rec('tests/a.test.ts', '甲', 900)], exempt, { 'tests/a.test.ts': { 甲: 1200 } });
  assert.match(r.text, /登记过原因的慢测试 1 条/);
  assert.doesNotMatch(r.text, /删掉/);
});

test('登记了、文件跑了却找不到这条：提示删掉；文件这一轮没跑的不提示', async () => {
  const exempt = { 'tests/a.test.ts': { 改名了: '原因' }, 'tests/b.test.ts': { 乙: '原因' } };
  const r = await check([rec('tests/a.test.ts', '甲', 10)], exempt, {});
  assert.match(r.text, /tests\/a\.test\.ts {2}改名了/);
  assert.doesNotMatch(r.text, /乙/);
});

test('同一份文件几条要单独计时：只重跑这份文件一次；几份文件一份接一份重跑；不越线的没登记测试不重跑', async () => {
  const records = [rec('tests/a.test.ts', '甲', 1100), rec('tests/a.test.ts', '乙', 1200), rec('tests/b.test.ts', '丙', 1050), rec('tests/c.test.ts', '丁', 300)];
  const { rerun, calls } = fakeRerun({ 'tests/a.test.ts': { 甲: 500, 乙: 600 }, 'tests/b.test.ts': { 丙: 400 } });
  let running = 0;
  const serialRerun = async (file, names) => {
    assert.equal(running++, 0, '重跑要串行');
    await Promise.resolve();
    running--;
    return rerun(file, names);
  };
  assert.equal(await checkSlow(records, {}, serialRerun, () => {}), 0);
  assert.deepEqual(calls, [
    { file: 'tests/a.test.ts', names: ['甲', '乙'] },
    { file: 'tests/b.test.ts', names: ['丙'] },
  ]);
});

test('越线的文件超过重跑上限：最长并行用时的先重跑，没轮到的结尾写明几份文件', async () => {
  const files = Array.from({ length: RERUN_FILES + 2 }, (_, i) => `tests/f${i}.test.ts`);
  const records = files.map((f, i) => rec(f, '慢', 1100 + i * 10));
  const alone = Object.fromEntries(files.map((f) => [f, { 慢: 1500 }]));
  const r = await check(records, {}, alone);
  assert.deepEqual(
    r.calls.map((c) => c.file),
    [...files].reverse().slice(0, RERUN_FILES),
  );
  assert.equal(r.slow, RERUN_FILES);
  assert.match(r.text, /还有 2 份文件越线、这一轮没单独计时/);
});

test('重跑先后按文件里越线测试的最长并行用时排：越线条数多但都只超一点的，排在只有一条但超得多的后面', async () => {
  const many = Array.from({ length: RERUN_FILES + 2 }, (_, i) => rec('tests/many.test.ts', '略超' + i, 1010));
  const r = await check([...many, rec('tests/one.test.ts', '超得多', 2400)], {}, {});
  assert.deepEqual(
    r.calls.map((c) => c.file),
    ['tests/one.test.ts', 'tests/many.test.ts'],
  );
});

test('按名字筛选的式子只认整名，名字里的括号、点、问号照字面匹配', () => {
  const re = new RegExp(namePattern('备份 (旧格式).sqlite?'));
  assert.ok(re.test('备份 (旧格式).sqlite?'));
  assert.ok(!re.test('备份 (旧格式).sqlite? 之后'));
  assert.ok(!re.test('备份 旧格式Xsqlite'));
});
