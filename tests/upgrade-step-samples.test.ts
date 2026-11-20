// 每个升级步骤（server/core/schema/steps.ts 的 upgradeSteps）都带一份数据样例，并且真的跑过：
// tests/schema-evolution.test.ts 只核对升级后的结构和新建的一样，回填、搬数据写错了（比如该填的没填、不该建的建了）它看不出来。
//
// 怎么登记样例（一个步骤一份小数据）：在 tests/fixtures/upgrade-samples/ 下建 v<版本号>.json，比如第 21 步是 v21.json：
//   {
//     "before": { "customers": [{ "id": 1, "name": "虚构客户", "contact": "", "phone": "", "address": "虚构地址",
//                                  "notes": "", "created_at": "2026-01-01T00:00:00.000Z", "updated_at": "2026-01-01T00:00:00.000Z" }] },
//     "after":  { "customers": [{ "id": 1, "address": "虚构地址", "新列": "回填后的值" }] }
//   }
// - before：升级前（第 版本号-1 版）要先写进库的行，表名 → 行；每行写全这张表必填的列。没有要准备的数据写 {}。
// - after：这一步跑完以后应该是什么样，表名 → 行，按行号（rowid）顺序；每行只写要核对的列，行数要和库里一样。至少写一张表。
// - 只用虚构数据。值只能是文字、数字或 null。
// 测试从第 20 版快照（tests/fixtures/schema-v20.sql）建一个内存库，先跑完前面的步骤，写进 before，只跑这一步，再逐表比 after。
// 步骤没有样例、样例对应的步骤不存在、样例写法不对，都会失败。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { z } from 'zod';
import { upgradeSchema, upgradeSteps, type UpgradeStep } from '../server/core/schema/index.js';

const SAMPLE_DIR = 'tests/fixtures/upgrade-samples';
const SNAPSHOT_FILE = 'tests/fixtures/schema-v20.sql';
const SAMPLE_NAME = /^v([1-9]\d*)\.json$/;
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const identifier = z.string().regex(/^[a-z_][a-z0-9_]*$/, '表名、列名只能是小写字母、数字和下划线');
const tableRows = z.record(identifier, z.array(z.record(identifier, z.union([z.string(), z.number(), z.null()]))));
const sampleSchema = z.strictObject({
  before: tableRows,
  after: tableRows.refine((tables) => Object.keys(tables).length > 0, '“after”至少写一张表'),
});
type Sample = z.output<typeof sampleSchema>;
type Cell = string | number | null;

/** 步骤和样例对不上的：有步骤没样例的版本、有样例没步骤的版本 */
function sampleCoverage(stepVersions: readonly number[], sampleVersions: readonly number[]) {
  return {
    missing: stepVersions.filter((v) => !sampleVersions.includes(v)),
    orphan: sampleVersions.filter((v) => !stepVersions.includes(v)),
  };
}

const HOW_TO = '写法见 tests/upgrade-step-samples.test.ts 开头';
/** 读一份样例：读出来的样例，或者写明哪里不对的一句话 */
function readSample(path: string): Sample | string {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return `${path}：不是合法的 JSON（${reasonOf(error)}），${HOW_TO}`;
  }
  const parsed = sampleSchema.safeParse(raw);
  return parsed.success
    ? parsed.data
    : `${path}：${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('；')}，${HOW_TO}`;
}

/** 读样例目录（还没有就是没有样例）：版本号 → 样例；文件名、写法不对的记进 problems */
function loadSamples(dir = SAMPLE_DIR) {
  const samples = new Map<number, Sample>(),
    problems: string[] = [];
  for (const file of existsSync(dir) ? readdirSync(dir) : []) {
    const match = SAMPLE_NAME.exec(file);
    if (!match) {
      problems.push(`${dir}/${file}：文件名要写成 v<版本号>.json，版本号不带前面的 0（第 21 步是 v21.json）`);
      continue;
    }
    const sample = readSample(`${dir}/${file}`);
    if (typeof sample === 'string') problems.push(sample);
    else samples.set(Number(match[1]), sample);
  }
  return { samples, problems };
}

/** 往库里写一张表的几行 */
function insertRows(db: DatabaseSync, table: string, rows: readonly Record<string, Cell>[]) {
  for (const row of rows) {
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO "${table}"(${cols.map((c) => `"${c}"`).join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(
      ...cols.map((c) => row[c]),
    );
  }
}
/** 库里一张表按行号的几行，只取样例写到的列 */
function actualRows(db: DatabaseSync, table: string, expected: readonly Record<string, Cell>[]) {
  const cols = [...new Set(expected.flatMap((row) => Object.keys(row)))];
  const list = cols.length ? cols.map((c) => `"${c}"`).join(',') : 'rowid';
  return db.prepare(`SELECT ${list} FROM "${table}" ORDER BY rowid`).all().map((row) => ({ ...row }));
}
/** 行数一样，每行样例写到的列都和库里一样（列的先后不管） */
const rowsMatch = (actual: readonly Record<string, unknown>[], expected: readonly Record<string, Cell>[]) =>
  actual.length === expected.length && expected.every((row, i) => Object.keys(row).every((c) => actual[i][c] === row[c]));

/**
 * 跑一步的样例：第 20 版快照建内存库 → 跑完这一步之前的步骤 → 写进 before → 只跑这一步 → 逐表比 after。
 * steps 是全部步骤（从第 21 版起连续）；返回对不上的地方，空的就是对上了
 */
function runSample(steps: readonly UpgradeStep[], version: number, sample: Sample): string[] {
  const index = steps.findIndex((s) => s.version === version);
  if (index < 0) return [`第 ${version} 版没有升级步骤`];
  const step = steps[index],
    label = `第 ${version} 步（${step.name}）`,
    db = new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync(SNAPSHOT_FILE, 'utf8'));
    if (index > 0) upgradeSchema(db, { appVersion: 'test-9.9.9', steps: steps.slice(0, index) });
    db.exec('PRAGMA foreign_keys=ON');
    for (const [table, rows] of Object.entries(sample.before)) insertRows(db, table, rows);
    upgradeSchema(db, { appVersion: 'test-9.9.9', steps: steps.slice(0, index + 1) });
    return Object.entries(sample.after).flatMap(([table, expected]) => {
      const actual = actualRows(db, table, expected);
      return rowsMatch(actual, expected)
        ? []
        : [`${label}跑完 ${table} 和样例不一样：\n  样例：${JSON.stringify(expected)}\n  实际：${JSON.stringify(actual)}`];
    });
  } catch (error) {
    return [`${label}的样例跑不通：${reasonOf(error)}`];
  } finally {
    db.close();
  }
}

test('每个升级步骤都登记了数据样例，样例真的跑过、结果和登记的一样', () => {
  const { samples, problems } = loadSamples();
  assert.deepEqual(problems, [], `${SAMPLE_DIR} 里的样例写法不对（写法见 tests/upgrade-step-samples.test.ts 开头）`);
  const { missing, orphan } = sampleCoverage(
    upgradeSteps.map((s) => s.version),
    [...samples.keys()],
  );
  assert.deepEqual(
    missing.map((v) => `第 ${v} 步没有数据样例：在 ${SAMPLE_DIR}/v${v}.json 写一份升级前后的小数据（写法见本测试文件开头）`),
    [],
  );
  assert.deepEqual(orphan.map((v) => `${SAMPLE_DIR}/v${v}.json 对应的第 ${v} 步不存在：步骤编号写错了，或这份样例该删了`), []);
  const ordered = [...upgradeSteps].sort((a, b) => a.version - b.version);
  assert.deepEqual([...samples].flatMap(([version, sample]) => runSample(ordered, version, sample)), []);
});

// ---------- 用造出来的步骤证明这条检查真的会拦 ----------

const made = '2026-01-01T00:00:00.000Z';
const customer = (id: number, address: string) => ({ id, name: '虚构客户' + id, contact: '', phone: '', address, notes: '', created_at: made, updated_at: made });
/** 第 21 步给客户加一列并按地址回填；第 22 步在这一列后面加一个字（要先有第 21 步才跑得了） */
const madeSteps: UpgradeStep[] = [
  {
    version: 21,
    name: '虚构：客户加地址标记',
    up: (db) =>
      db.exec(`ALTER TABLE customers ADD COLUMN fictional_label TEXT NOT NULL DEFAULT '';
        UPDATE customers SET fictional_label='有地址' WHERE address<>''`),
  },
  { version: 22, name: '虚构：标记加一个字', up: (db) => db.exec("UPDATE customers SET fictional_label=fictional_label||'！'") },
];
const sample21: Sample = {
  before: { customers: [customer(1, '虚构地址'), customer(2, '')] },
  after: { customers: [{ id: 1, fictional_label: '有地址' }, { id: 2, fictional_label: '' }] },
};

test('升级样例的检查真的会拦：步骤没带样例被报出来，带了的真跑并比对结果', () => {
  assert.deepEqual(sampleCoverage([21], []), { missing: [21], orphan: [] });
  assert.deepEqual(sampleCoverage([21], [21]), { missing: [], orphan: [] });
  assert.deepEqual(sampleCoverage([], [21]), { missing: [], orphan: [21] });
  assert.deepEqual(runSample(madeSteps, 21, sample21), []);
  const wrong = { ...sample21, after: { customers: [{ id: 1, fictional_label: '有地址' }, { id: 2, fictional_label: '有地址' }] } };
  assert.match(runSample(madeSteps, 21, wrong).join('\n'), /第 21 步（虚构：客户加地址标记）跑完 customers 和样例不一样/);
  // 第 22 步的 before 用到第 21 步加的列：先跑完前面的步骤才写得进去
  const sample22: Sample = {
    before: { customers: [{ ...customer(3, ''), fictional_label: '虚构' }] },
    after: { customers: [{ id: 3, fictional_label: '虚构！' }] },
  };
  assert.deepEqual(runSample(madeSteps, 22, sample22), []);
  assert.match(runSample(madeSteps, 21, sample22).join('\n'), /样例跑不通.*fictional_label/);
});

test('升级样例的写法不对会报出来：文件名、缺 after、值不是文字数字或 null', () => {
  assert.equal(sampleSchema.safeParse({ before: {}, after: {} }).success, false);
  assert.equal(sampleSchema.safeParse({ before: {}, after: { customers: [{ id: [1] }] } }).success, false);
  assert.equal(sampleSchema.safeParse(sample21).success, true);
  assert.deepEqual(loadSamples('tests/fixtures/虚构不存在的目录'), { samples: new Map(), problems: [] });
  const dir = mkdtempSync(join(tmpdir(), 'erp-upgrade-samples-'));
  try {
    writeFileSync(join(dir, '第21步.json'), '{}');
    writeFileSync(join(dir, 'v21.json'), JSON.stringify({ before: {} }));
    writeFileSync(join(dir, 'v22.json'), JSON.stringify(sample21));
    writeFileSync(join(dir, 'v022.json'), JSON.stringify(sample21));
    writeFileSync(join(dir, 'v23.json'), '{ "before": {}, 写坏了');
    const { samples, problems } = loadSamples(dir);
    assert.deepEqual([...samples.keys()], [22]);
    assert.equal(problems.length, 4);
    const text = problems.join('\n');
    assert.match(text, /第21步\.json：文件名要写成 v<版本号>\.json/);
    assert.match(text, /v022\.json：文件名要写成 v<版本号>\.json，版本号不带前面的 0/);
    assert.match(text, /v21\.json：after.*写法见 tests\/upgrade-step-samples\.test\.ts 开头/);
    assert.match(text, /v23\.json：不是合法的 JSON（[^）]+），写法见/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
