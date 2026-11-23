// 文档里点到的项目文件要真的存在：docs/ 下的 .md、AGENTS.md、.claude/子智能体须知.md 里用反引号写的
// server/、shared/、src/、tests/、scripts/ 路径（AI 读文档主要靠这些路径找代码）。文档只写现状，删掉的文件不该再留在文档里。
// 现成的链接检查工具只管 Markdown 链接，不管反引号里的路径，所以自己查。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

/** 本来就不是现有文件的路径和原因：举例用的、路线图里写的要新建的。建出来了、文档不提了就删掉 */
const notFiles: Record<string, string> = {
  'src/data/': '子智能体须知里举例说明“src/data/ 这种不会被钩子拦”',
};

const markdown = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? markdown(join(dir, e.name)) : e.name.endsWith('.md') ? [join(dir, e.name).split(sep).join('/')] : [],
  );
const docs = [...markdown('docs'), 'AGENTS.md', '.claude/子智能体须知.md'];
const pathPattern = /`((?:server|shared|src|tests|scripts)\/[^`\s]*)`/g;

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

test('名单里的路径还出现在文档里、也确实还不存在（建出来了、不提了就删掉）', () => {
  const all = docs.map((d) => readFileSync(d, 'utf8')).join('\n');
  assert.deepEqual(
    Object.keys(notFiles)
      .filter((p) => !all.includes('`' + p + '`') || existsSync(p))
      .map((p) => p + '：文档里不再提或文件已经建出来了，从 notFiles 名单里删掉'),
    [],
  );
});
