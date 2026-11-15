// 文件的大小（AGENTS.md“文件怎么分”）：程序（server/、shared/、src/）、样式（src/ 下的 .css）、脚本（scripts/）、
// 测试（tests/，连同测试数据里的文本文件）超过 500 行就失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

const LIMIT = 500;
const roots: [dir: string, pattern: RegExp][] = [
  ['server', /\.tsx?$/],
  ['shared', /\.tsx?$/],
  ['src', /\.(tsx?|css)$/],
  ['scripts', /\.(tsx?|mts|mjs|cjs|js|sh)$/],
  ['tests', /\.(tsx?|mts|mjs|cjs|js|sql)$/],
];
/** 确有理由超过 500 行的文件和理由。加一条要写清为什么拆不开。 */
const allowed: Record<string, string> = {
  'tests/fixtures/schema-v20.sql': '第 20 版结构快照：npm run schema:dump 从建表生成，测试按字节比对 sha256，不手改、不拆',
};

const sources = (dir: string, pattern: RegExp): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? e.name === 'node_modules'
        ? []
        : sources(join(dir, e.name), pattern)
      : pattern.test(e.name)
        ? [join(dir, e.name).split(sep).join('/')]
        : [],
  );
const all = () => roots.flatMap(([dir, pattern]) => sources(dir, pattern));
const lineCount = (file: string) => {
  const text = readFileSync(file, 'utf8');
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
};

test('程序、样式、脚本、测试文件不超过 500 行（例外写在名单里并注明原因）', () => {
  const over = all().flatMap((f) => {
    const n = lineCount(f);
    return n > LIMIT && !allowed[f] ? [f + '：' + n + ' 行'] : [];
  });
  assert.deepEqual(over, [], '这些文件超过 ' + LIMIT + ' 行，按“一个文件只管一件事”拆开');
});

test('例外名单里的文件都还存在、还超过 500 行（拆完就从名单里删掉）', () => {
  const files = new Set(all());
  const stale = Object.keys(allowed).filter((f) => !files.has(f) || lineCount(f) <= LIMIT);
  assert.deepEqual(stale, []);
});
