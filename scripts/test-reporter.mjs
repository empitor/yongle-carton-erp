// node:test 报告器：每条顶层测试写一行 JSON（文件、名字、用时毫秒），给 run-tests.mjs 按用时分组、查慢测试用。
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export default async function* timings(source) {
  for await (const e of source) {
    if ((e.type !== 'test:pass' && e.type !== 'test:fail') || e.data.nesting !== 0 || !e.data.file) continue;
    const file = relative(root, e.data.file).replaceAll('\\', '/');
    yield JSON.stringify({ file, name: e.data.name, ms: Math.round(e.data.details?.duration_ms ?? 0) }) + '\n';
  }
}
