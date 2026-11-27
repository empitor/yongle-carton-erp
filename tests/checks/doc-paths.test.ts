// 文档里点到的项目文件要真的存在：docs/ 下的 .md、AGENTS.md、技能和子智能体定义里用反引号写的
// server/、shared/、src/、tests/、scripts/、.claude/ 路径和 docs/…md（AI 读文档主要靠这些路径找代码和别的文档），
// 以及 Markdown 相对链接 [文字](….md) 指到的文档。文档只写现状，删掉的、搬走的文件不该再留在文档里。
// 现成的链接检查工具只管 Markdown 链接，不管反引号里的路径，所以一起自己查。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { docFiles } from './doc-files.js';

/** 本来就不是现有文件的路径和原因：举例用的、路线图里写的要新建的。建出来了、文档不提了就删掉 */
const notFiles: Record<string, string> = {};

const docs = docFiles();
const pathPattern = /`((?:server|shared|src|tests|scripts|\.claude)\/[^`\s]*|docs\/[^`\s]*\.md)`/g;
/** Markdown 相对链接：[文字](路径.md) 或带 #锚点 的，外网地址不算 */
const linkPattern = /\]\(((?![a-z]+:)[^)\s#]+\.md)(?:#[^)\s]*)?\)/g;

test('文档里反引号写的项目路径都存在（行号、锚点不算；带 * < > { } 的是写法示意，不查）', () => {
  const missing: string[] = [];
  for (const doc of docs) {
    const text = readFileSync(doc, 'utf8');
    for (const m of text.matchAll(pathPattern)) {
      if (notFiles[m[1]] || /[*<>{}]/.test(m[1])) continue;
      const path = m[1].replace(/[#:].*$/, '').replace(/\/$/, '');
      const line = text.slice(0, m.index).split('\n').length;
      if (!existsSync(path)) missing.push(`${doc}:${line} ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], '文档里写了这些路径，但文件已经不在：改成现在的位置，或把这句删掉');
});

test('文档里的 Markdown 相对链接指到的文档都在（按这份文档所在的目录算）', () => {
  const missing: string[] = [];
  for (const doc of docs) {
    const text = readFileSync(doc, 'utf8');
    for (const m of text.matchAll(linkPattern)) {
      const target = posix.normalize(posix.join(posix.dirname(doc), decodeURI(m[1])));
      const line = text.slice(0, m.index).split('\n').length;
      if (!existsSync(target)) missing.push(`${doc}:${line} ${m[1]}（找的是 ${target}）`);
    }
  }
  assert.deepEqual(missing, [], '这些链接指的文档已经不在：改成现在的文档，或把链接删掉');
});

test('名单里的路径还出现在文档里、也确实还不存在（建出来了、不提了就删掉）', () => {
  const all = docs.map((d) => readFileSync(d, 'utf8')).join('\n');
  assert.deepEqual(
    Object.keys(notFiles)
      .filter((p) => !all.includes('`' + p + '`') || existsSync(p))
      .map((p) => p + '：文档里不再提或文件已经建出来了，从 notFiles 名单里删掉'),
    [],
  );
});
