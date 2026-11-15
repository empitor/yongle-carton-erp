import { DatabaseSync } from 'node:sqlite';
import { buildTables, createSchema, type SchemaBuild } from './create.js';
import { describeSchema, schemaFingerprint, type SchemaDescription } from './describe.js';

/*
 * 库的结构和程序对不对得上：打开业务库（index.ts）和恢复备份（../backup-check.ts）都用这里，一个口径——
 * 结构指纹（describe.ts，只算表、列、约束、索引、触发器、视图）和应有的结构相同才算对得上，对不上再列出差在哪。
 */

/** 在内存库里建“应有的结构”时写进版本记录的程序版本（库用完就扔，结构比较不比这一列） */
const EXPECTED_APP_VERSION = 'expected-schema';
/** 提示里每一类最多列几个名字，多的写“等 N 张” */
const LISTED_NAMES = 8;

const described = new WeakMap<SchemaBuild, SchemaDescription>();
/**
 * 应有的库结构：按这套建表在内存里建一个空库读出来（每套只算一次）。建表就是当前完整结构，升级步骤走完也必须是它，
 * 所以只看建表。正式用当前程序的 tables/（buildTables）；测试换了一套建表和步骤的，传它自己那套。
 */
function expectedSchema(build: SchemaBuild): SchemaDescription {
  const known = described.get(build);
  if (known) return known;
  const db = new DatabaseSync(':memory:');
  try {
    createSchema(db, { appVersion: EXPECTED_APP_VERSION, build });
    const description = describeSchema(db);
    described.set(build, description);
    return description;
  } finally {
    db.close();
  }
}

/** 当前程序新建的库的结构指纹 */
export const expectedSchemaFingerprint = () => schemaFingerprint(expectedSchema(buildTables));

/** 和应有的结构比，差在哪：表名，以及索引、触发器、视图（前面带种类） */
export type SchemaMismatch = { missing: string[]; extra: string[]; changed: string[]; others: string[] };

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** 只有应有的结构里有的、只有库里有的、两边都有但内容不同的名字 */
function compareNamed(actual: Record<string, unknown>, expected: Record<string, unknown>) {
  const names = (from: Record<string, unknown>, keep: (name: string) => boolean) => Object.keys(from).filter(keep).sort();
  return {
    missing: names(expected, (name) => !(name in actual)),
    extra: names(actual, (name) => !(name in expected)),
    changed: names(expected, (name) => name in actual && !sameJson(actual[name], expected[name])),
  };
}
function differing(kind: string, actual: Record<string, string>, expected: Record<string, string>) {
  const found = compareNamed(actual, expected);
  return [...found.missing, ...found.extra, ...found.changed].map((name) => kind + ' ' + name);
}

/**
 * 库的结构和按 build 新建出来的结构（默认是当前程序的建表）比：对得上返回 null，对不上返回差在哪。只读。
 * 版本号是当前版本才有比的意义（别的版本应有的结构不一样）。
 */
export function schemaMismatch(db: DatabaseSync, build: SchemaBuild = buildTables): SchemaMismatch | null {
  const actual = describeSchema(db);
  const expected = expectedSchema(build);
  if (schemaFingerprint(actual) === schemaFingerprint(expected)) return null;
  return {
    ...compareNamed(actual.tables, expected.tables),
    others: [
      ...differing('索引', actual.indexes, expected.indexes),
      ...differing('触发器', actual.triggers, expected.triggers),
      ...differing('视图', actual.views, expected.views),
    ],
  };
}

const listed = (names: string[], unit: string) =>
  names.length > LISTED_NAMES ? `${names.slice(0, LISTED_NAMES).join('、')} 等 ${names.length} ${unit}` : names.join('、');
/** 差在哪，一类一行，每类最多列几个名字 */
export function mismatchLines(mismatch: SchemaMismatch): string[] {
  const lines: [string, string[], string][] = [
    ['缺了的表', mismatch.missing, '张'],
    ['多出的表', mismatch.extra, '张'],
    ['结构不同的表', mismatch.changed, '张'],
    ['索引、触发器、视图不同', mismatch.others, '个'],
  ];
  return lines.filter(([, names]) => names.length).map(([label, names, unit]) => `${label}：${listed(names, unit)}`);
}
