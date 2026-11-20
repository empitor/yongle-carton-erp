// 首屏脚本体积上限：打开网址就要下载的脚本只许变小。
// 量法：构建到临时目录并让 Vite 写出自带的 manifest（--manifest），取 isEntry 的入口块，
// 加上顺着 imports（静态引用）一路带进来的块；dynamicImports 是用到才下载的，不算。样式不算。
// 大小按 gzip 9 级算：正式环境 Caddy 对 /assets/* 开了 gzip，浏览器下载的接近这个数。
// 超过上限失败；比上限小太多也失败，提示把上限调低（上限只许调低，不许调高）。
// 点了才用的窗口和财务段不许进首屏：manifest 只记块、不记块里有哪些源文件，所以同一次构建再写出
// hidden 的 source map（不往产物里加注释，大小不变），按 map 的 sources 看首屏块里混进了哪些源文件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, gzipSync } from 'node:zlib';
import { z } from 'zod';

/**
 * 首屏脚本 gzip 后的总字节数上限。只许调低，不许调高。
 * measured 是量出来的大小，bytes = measured 加 MARGIN 余量后向上取整。
 */
const FIRST_SCREEN_LIMIT = { date: '2026-11-21', measured: 217_250, bytes: 221_595 };
/** 定上限时在实测大小上加的余量（不超过 3%） */
const MARGIN = 0.02;
/** 实测比上限小这么多以上，算上限太松：首屏变小了就把上限跟着调低 */
const LOOSE = 0.05;
/** 报错里列出最大的几块 */
const SHOW_LARGEST = 5;
/**
 * 点了才用的窗口和订单、送货、到货详情里的财务段：只许按需加载，不许出现在首屏的块里。
 * 有人把它们改回静态引用，就会被打进首屏。
 */
const NOT_IN_FIRST_SCREEN = [
  'src/finance/FinanceRelated.tsx',
  'src/flow/CorrectionDialog.tsx',
  'src/recordkit/DatabaseDeleteDialog.tsx',
  'src/editors/CustomerEditor.tsx',
  'src/editors/OrderEditor.tsx',
  'src/editors/ProductEditor.tsx',
  'src/import/InboxPage.tsx',
];

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifestSchema = z.record(
  z.string(),
  z.object({ file: z.string(), isEntry: z.boolean().optional(), imports: z.array(z.string()).optional() }),
);
type Manifest = z.infer<typeof manifestSchema>;
type Chunk = { file: string; gzip: number };
/** 一次构建：清单，和每个产物文件由哪些源文件打成（从项目根目录写起的路径） */
type Build = { manifest: Manifest; sourcesOf: (file: string) => string[] };

/** 首屏要下载的脚本：入口块和它静态带进来的块（manifest 的 imports 一路往下走），返回产物文件名 */
function firstScreenFiles(manifest: Manifest): string[] {
  const chunks = new Map(Object.entries(manifest));
  const seen = new Set<string>();
  const files: string[] = [];
  const visit = (key: string) => {
    if (seen.has(key)) return;
    const chunk = chunks.get(key);
    if (!chunk) throw new Error(`manifest 里引用了不存在的块“${key}”：构建产物不完整，重新构建再量`);
    seen.add(key);
    files.push(chunk.file);
    for (const next of chunk.imports ?? []) visit(next);
  };
  const entries = [...chunks].filter(([, c]) => c.isEntry).map(([key]) => key);
  if (!entries.length) throw new Error('manifest 里没有入口块（isEntry）：构建产物不对，检查 vite 构建');
  entries.forEach(visit);
  return files;
}

const kb = (bytes: number) => (bytes / 1024).toFixed(1) + ' KB';
const suggestedLimit = (total: number) => Math.ceil(total * (1 + MARGIN));

/** 首屏脚本大小和上限比：超了、或上限太松，返回中文说明；正常返回 null */
function firstScreenProblem(chunks: Chunk[], limit: number): string | null {
  const total = chunks.reduce((sum, c) => sum + c.gzip, 0);
  if (total > limit) {
    const largest = [...chunks]
      .sort((a, b) => b.gzip - a.gzip)
      .slice(0, SHOW_LARGEST)
      .map((c) => `${c.file} ${kb(c.gzip)}`);
    return (
      `首屏脚本 gzip 后 ${kb(total)}（${total} 字节），超过上限 ${kb(limit)}（${limit} 字节），多了 ${kb(total - limit)}。` +
      `首屏共 ${chunks.length} 块，最大的几块：${largest.join('、')}。` +
      '点了才用的窗口、页面改成按需加载（React.lazy 或 import()），不要调高上限（tests/release/first-screen-size.test.ts 的 FIRST_SCREEN_LIMIT 只许调低）。'
    );
  }
  if (total * (1 + LOOSE) < limit)
    return (
      `首屏脚本 gzip 后 ${kb(total)}（${total} 字节），比上限 ${kb(limit)} 小了 ${(100 - (total / limit) * 100).toFixed(1)}%：` +
      `上限只许调低，把 tests/release/first-screen-size.test.ts 的 FIRST_SCREEN_LIMIT 改成 measured: ${total}、bytes: ${suggestedLimit(total)}，日期改成今天。`
    );
  return null;
}

/**
 * 不该在首屏的源文件落在了首屏的块里：返回“源文件（在哪一块）”。
 * 名单里的文件哪一块都找不到（改了名、删了，或 source map 没写出来）也算问题，免得检查悄悄失效。
 */
function lazyInFirstScreen({ manifest, sourcesOf }: Build): string[] {
  const first = new Set(firstScreenFiles(manifest));
  const all = Object.values(manifest).map((c) => c.file);
  const problems: string[] = [];
  for (const source of NOT_IN_FIRST_SCREEN) {
    const holders = all.filter((file) => sourcesOf(file).includes(source));
    if (!holders.length) problems.push(`${source}（哪一块里都没有：改了名就更新 NOT_IN_FIRST_SCREEN）`);
    for (const file of holders.filter((f) => first.has(f))) problems.push(`${source}（在首屏的 ${file} 里）`);
  }
  return problems;
}

let built: { build: Build; chunks: Chunk[] } | undefined;
/** 构建到临时目录（一个文件里只构建一次，两条真实构建的测试共用），返回清单、各块的源文件和首屏块 gzip 后的大小 */
function buildOnce() {
  built ??= buildAndMeasure();
  return built;
}

function buildAndMeasure(): { build: Build; chunks: Chunk[] } {
  const out = mkdtempSync(join(tmpdir(), 'erp-first-screen-'));
  // esbuild 的中转文件放项目里的 .build-tmp-*，原因见 scripts/build.mjs
  const buildTmp = mkdtempSync(join(root, '.build-tmp-'));
  try {
    const vite = join(root, 'node_modules/vite/bin/vite.js');
    const run = spawnSync(process.execPath, [vite, 'build', '--outDir', out, '--emptyOutDir', '--manifest', '--sourcemap', 'hidden', '--logLevel', 'warn'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, TMP: buildTmp, TEMP: buildTmp },
    });
    assert.equal(run.status, 0, `构建失败：\n${run.stdout}${run.stderr}`);
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(out, '.vite/manifest.json'), 'utf8')));
    const sources = new Map(Object.values(manifest).map((c) => [c.file, mapSources(join(out, c.file + '.map'))]));
    const chunks = firstScreenFiles(manifest).map((file) => ({
      file,
      gzip: gzipSync(readFileSync(join(out, file)), { level: constants.Z_BEST_COMPRESSION }).length,
    }));
    return { build: { manifest, sourcesOf: (file) => sources.get(file) ?? [] }, chunks };
  } finally {
    removeLater(out);
    removeLater(buildTmp);
  }
}

const mapSchema = z.object({ sources: z.array(z.string()) });
/** 一个产物的 source map 里列的源文件，换成从项目根目录写起、正斜杠的路径；没有 map 的产物（不是脚本）返回空 */
function mapSources(mapFile: string): string[] {
  let text: string;
  try {
    text = readFileSync(mapFile, 'utf8');
  } catch {
    return [];
  }
  return mapSchema
    .parse(JSON.parse(text))
    .sources.map((s) => relative(root, resolve(dirname(mapFile), s)).replace(/\\/g, '/'));
}

/** 删临时目录；删不掉不抛错，免得盖掉量出的结果 */
function removeLater(path: string) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Node 的编译缓存、杀毒软件偶尔还占着句柄（见 scripts/build.mjs）。留下的 .build-tmp-* 下次构建前
    // scripts/build.mjs 会清掉，系统临时目录里的由系统清，所以只提示、不让测试失败。
    console.warn('临时目录这次没删掉，留给下次清理：' + path);
  }
}

test('首屏脚本：入口加上静态引用一路带进来的块，按需加载的不算', () => {
  const manifest: Manifest = {
    'index.html': { file: 'assets/index.js', isEntry: true, imports: ['_vendor.js'] },
    '_vendor.js': { file: 'assets/vendor.js', imports: ['_icons.js', 'index.html'] },
    '_icons.js': { file: 'assets/icons.js' },
    'src/finance/pages.ts': { file: 'assets/pages.js', imports: ['_vendor.js'] },
  };
  assert.deepEqual(firstScreenFiles(manifest).sort(), ['assets/icons.js', 'assets/index.js', 'assets/vendor.js']);
});

test('manifest 没有入口、或引用了不存在的块：直接报错，不当成 0 字节', () => {
  assert.throws(() => firstScreenFiles({ 'a.js': { file: 'assets/a.js' } }), /没有入口块/);
  assert.throws(() => firstScreenFiles({ 'index.html': { file: 'assets/index.js', isEntry: true, imports: ['_gone.js'] } }), /_gone\.js/);
});

test('首屏超过上限：失败，写明现在多大、上限多少、哪几块最大', () => {
  const chunks = [
    { file: 'assets/index.js', gzip: 9000 },
    { file: 'assets/vendor.js', gzip: 2000 },
  ];
  const problem = firstScreenProblem(chunks, 10_000) ?? '';
  assert.match(problem, /11000 字节/);
  assert.match(problem, /上限 9\.8 KB（10000 字节）/);
  assert.match(problem, /最大的几块：assets\/index\.js 8\.8 KB、assets\/vendor\.js 2\.0 KB/);
});

test('首屏没超上限、上限也不太松：放过', () => {
  assert.equal(firstScreenProblem([{ file: 'assets/index.js', gzip: 9800 }], 10_000), null);
  assert.equal(firstScreenProblem([{ file: 'assets/index.js', gzip: 10_000 }], 10_000), null);
});

test('首屏比上限小太多：提示把上限调低到实测加余量', () => {
  const problem = firstScreenProblem([{ file: 'assets/index.js', gzip: 9000 }], 10_000) ?? '';
  assert.match(problem, /只许调低/);
  assert.match(problem, new RegExp(`bytes: ${suggestedLimit(9000)}`));
});

test('上限的余量不超过 3%', () => {
  assert.ok(FIRST_SCREEN_LIMIT.bytes <= FIRST_SCREEN_LIMIT.measured * 1.03, `上限 ${FIRST_SCREEN_LIMIT.bytes} 比实测 ${FIRST_SCREEN_LIMIT.measured} 多出超过 3%`);
});

/** 造一份清单：入口静态带进 _shared，按需加载 _lazy；各块的源文件由 sources 给 */
const fakeBuild = (sources: Record<string, string[]>): Build => ({
  manifest: {
    'index.html': { file: 'assets/index.js', isEntry: true, imports: ['_shared.js'] },
    '_shared.js': { file: 'assets/shared.js' },
    '_lazy.js': { file: 'assets/lazy.js', imports: ['_shared.js'] },
  },
  sourcesOf: (file) => sources[file] ?? [],
});
const everyGuarded = (except: string) => NOT_IN_FIRST_SCREEN.filter((s) => s !== except);

test('点了才用的窗口、财务段被静态带进首屏的块：拦下，写明哪个文件在哪一块', () => {
  const build = fakeBuild({
    'assets/index.js': ['src/main.tsx'],
    'assets/shared.js': ['src/flow/CorrectionDialog.tsx'],
    'assets/lazy.js': everyGuarded('src/flow/CorrectionDialog.tsx'),
  });
  assert.deepEqual(lazyInFirstScreen(build), ['src/flow/CorrectionDialog.tsx（在首屏的 assets/shared.js 里）']);
});

test('点了才用的窗口、财务段都在按需加载的块里：放过', () => {
  const build = fakeBuild({ 'assets/index.js': ['src/main.tsx'], 'assets/lazy.js': NOT_IN_FIRST_SCREEN });
  assert.deepEqual(lazyInFirstScreen(build), []);
});

test('名单里的文件哪一块都找不到：报出来，不当成没问题', () => {
  const build = fakeBuild({ 'assets/lazy.js': everyGuarded('src/import/InboxPage.tsx') });
  assert.deepEqual(lazyInFirstScreen(build), ['src/import/InboxPage.tsx（哪一块里都没有：改了名就更新 NOT_IN_FIRST_SCREEN）']);
});

test('真实构建：首屏脚本 gzip 后不超过上限', () => {
  const problem = firstScreenProblem(buildOnce().chunks, FIRST_SCREEN_LIMIT.bytes);
  assert.equal(problem, null, problem ?? '');
});

test('真实构建：点了才用的窗口和财务段不在首屏的块里', () => {
  assert.deepEqual(lazyInFirstScreen(buildOnce().build), []);
});
