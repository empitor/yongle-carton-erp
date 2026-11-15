// run-tests.mjs 跑完后的统计：按上次实测用时分组、记下这次的用时。慢测试的上限也定在这里，怎么判见 test-slow.mjs。
// 用时记在 node_modules/.cache（不进 git）：每次跑完把跑到的文件更新进去，删掉的测试文件顺手去掉。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 单条测试的用时上限（毫秒） */
export const SLOW_MS = 1000;

const timingsFile = (root) => join(root, 'node_modules/.cache/erp-tests/timings.json');

/** 上次记下的每份测试文件用时（毫秒）；从没跑过是空表 */
export function loadTimings(root) {
  const file = timingsFile(root);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

/** 把这次跑到的文件用时并进去；已经不存在的测试文件去掉 */
export function saveTimings(root, old, records) {
  const merged = Object.fromEntries(Object.entries(old).filter(([f]) => existsSync(join(root, f))));
  for (const [f, ms] of Object.entries(fileTimes(records))) merged[f] = ms;
  mkdirSync(dirname(timingsFile(root)), { recursive: true });
  writeFileSync(timingsFile(root), JSON.stringify(merged, null, 1) + '\n');
}

/** 报告器每条测试一行 JSON → 每份文件的用时合计 */
export function fileTimes(records) {
  const out = {};
  for (const r of records) out[r.file] = (out[r.file] ?? 0) + r.ms;
  return out;
}

/** 按用时装箱：慢的先放，每次放进最空的那组。没有记录的文件（新加、改名）按有记录文件的平均用时算 */
export function packShards(files, timings, jobs) {
  const known = files.filter((f) => timings[f] !== undefined);
  const average = known.length ? known.reduce((n, f) => n + timings[f], 0) / known.length : 1;
  const weight = (f) => timings[f] ?? average;
  const shards = Array.from({ length: jobs }, () => ({ files: [], weight: 0 }));
  for (const f of [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const lightest = shards.reduce((a, b) => (b.weight < a.weight ? b : a));
    lightest.files.push(f);
    lightest.weight += weight(f);
  }
  return shards.filter((s) => s.files.length);
}

export const readRecords = (file) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
