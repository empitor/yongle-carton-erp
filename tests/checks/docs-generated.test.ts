// docs/生成/ 下的文档由 npm run docs:gen 从代码生成（每份从哪来见 scripts/docs-gen/generated-docs.ts）：
// 这里重新生成一遍，和仓库里的逐字比（换行按 LF 算，和检出方式无关）。对不上就是改了建表注释、配置库规格、模块表却没重新生成，
// 或者有人手改了生成的文档。只在内存里建库，不碰数据文件。
// 另查 docs/生成/ 下只有登记了的那几份：这个目录不算字数、不比对没登记的，手写的文档、生成器删掉一份后留下的旧文件都不许放这里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { generatedDocs } from '../../scripts/docs-gen/generated-docs.js';

const GENERATED_DIR = 'docs/生成';

/** 两份文字从第几行起不一样（行号从 1 起） */
function firstDifference(a: string, b: string) {
  const left = a.split('\n');
  const right = b.split('\n');
  const line = left.findIndex((text, i) => text !== right[i]);
  return (line < 0 ? left.length : line) + 1;
}

test('docs/生成/ 下的文档和代码重新生成的一字不差', () => {
  const stale = generatedDocs().flatMap((doc) => {
    if (!existsSync(doc.path)) return [doc.path + '：还没生成'];
    const saved = readFileSync(doc.path, 'utf8').replace(/\r\n/g, '\n');
    return saved === doc.text ? [] : [`${doc.path}：从第 ${firstDifference(saved, doc.text)} 行起对不上`];
  });
  assert.deepEqual(
    stale,
    [],
    '生成的文档和代码对不上：跑 npm run docs:gen 重新生成再一起提交。不要手改生成的文档，要改说明就改代码里的注释或说明字段',
  );
});

test('docs/生成/ 下的文件和 generated-docs.ts 登记的一份不多一份不少', () => {
  const registered = generatedDocs().map((doc) => doc.path).sort();
  const present = readdirSync(GENERATED_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => `${entry.parentPath}/${entry.name}`.replaceAll('\\', '/'))
    .sort();
  assert.deepEqual(
    present,
    registered,
    'docs/生成/ 只放 scripts/docs-gen/generated-docs.ts 登记的生成文档：手写的挪到对应门类，生成器不再生成的旧文件删掉，新加的生成文档先登记',
  );
});
