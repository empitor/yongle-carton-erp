// 外壳的边界：产品源码是登记过的几个文件，核心里的文件按登记表只往下引、没有循环，启动器只用标准库；
// 运行时只依赖登记过的包；安装包引用的文件都在本目录里；ERP 网页拿不到外壳接口（不开 IPC 权限、插件不注入脚本）；
// 启动画面的窗口装得下整段动画；文件不超过 500 行。依赖、插件、生成的权限清单这几条要用 cargo metadata 和编译生成物：
// 先 . .\scripts\env.ps1，并编译过一次。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const tauriDir = join(project, 'src-tauri');
const read = (file) => readFileSync(file, 'utf8');
const inside = (file) => {
  const rel = relative(project, resolve(file));
  return !isAbsolute(rel) && !rel.startsWith('..');
};
const ignored = new Set(['node_modules', 'target', 'gen', '.git']);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (ignored.has(entry.name)) return [];
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/** 行数：末尾的换行不算一行（和 ERP 根目录 tests/file-size.test.ts 一个算法） */
const lineCount = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

let metadataCache;
/**
 * cargo metadata --offline 的结果（按 Cargo.lock 锁定的版本，从本机 cargo 的下载目录读）：
 * 要先 . .\scripts\env.ps1，并编译过一次或 cargo fetch。依赖不管在 Cargo.toml 里用哪种写法，这里都看得见
 */
function metadata() {
  if (!metadataCache) {
    const args = ['metadata', '--offline', '--format-version', '1', '--manifest-path', join(tauriDir, 'Cargo.toml')];
    const result = spawnSync('cargo', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(result.status, 0, 'cargo metadata 没成功（先 . .\\scripts\\env.ps1，并编译过一次）：' + result.stderr);
    metadataCache = JSON.parse(result.stdout);
  }
  return metadataCache;
}

/** 外壳自己的直接依赖（包名）：kind 是 null（运行时）、'build'、'dev'，不分平台 */
function directDeps(kind) {
  const { packages, resolve: graph } = metadata();
  const root = graph.nodes.find((node) => node.id === graph.root);
  return root.deps
    .filter((dep) => dep.dep_kinds.some((k) => k.kind === kind))
    .map((dep) => packages.find((p) => p.id === dep.pkg))
    .map((p) => p.name)
    .sort();
}

/**
 * 核心里每个文件能引哪几个（只往下引，没有循环；为什么这样分见 docs/架构说明.md）。
 * lib 是入口，其余由它用 mod 声明；启动器 launcher 是另一个程序，单独查。
 */
const USES = {
  lib: ['autostart', 'config', 'notice', 'pages', 'report', 'splash', 'tray', 'updater', 'window'],
  tray: ['autostart', 'config', 'notice', 'report', 'updater', 'window'],
  autostart: ['report'],
  window: ['config', 'loading', 'notice', 'pages', 'popup', 'report', 'route', 'splash'],
  popup: ['loading', 'notice', 'report', 'route'],
  loading: ['pages', 'report', 'route'],
  updater: ['autostart', 'config', 'notice', 'report'],
  splash: ['report'],
  route: ['pages'],
  config: [],
  notice: [],
  pages: [],
  report: [],
};
const MODULES = Object.keys(USES);
const SOURCES = ['launcher', ...MODULES].map((name) => `src/${name}.rs`).sort();
const source = (name) => read(join(tauriDir, 'src', name + '.rs'));

/** 去掉字符串和 // 注释，只留代码 */
function code(text) {
  return text
    .replace(/r(#*)"[\s\S]*?"\1/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/\/\/.*$/gm, '');
}

/** 一个文件引了核心里的哪些文件：crate::x、use crate::{x, y}，以及 use 之后直接写的 x:: */
function usesOf(name) {
  const text = code(source(name));
  const found = new Set();
  for (const m of text.matchAll(/(?<![:\w])crate::(\w+)/g)) found.add(m[1]);
  for (const m of text.matchAll(/use\s+crate::\{([^}]*)\}/g)) {
    for (const item of m[1].split(',')) found.add(item.trim().split('::')[0]);
  }
  for (const m of text.matchAll(/(?<![:\w])(\w+)::/g)) if (MODULES.includes(m[1])) found.add(m[1]);
  found.delete('');
  found.delete(name);
  return [...found].sort();
}

test('产品源码只有登记过的几个文件', () => {
  const sources = walk(join(tauriDir, 'src')).map((f) => relative(tauriDir, f).split(sep).join('/'));
  assert.deepEqual(sources.sort(), SOURCES);
});

test('只有入口用 mod 声明核心里的文件，都不 include 外部内容', () => {
  const modsOf = (name) => code(source(name)).split('\n').filter((line) => /^\s*(pub\s+)?mod\s+\w+\s*;/.test(line));
  assert.deepEqual(modsOf('lib'), MODULES.filter((m) => m !== 'lib').sort().map((m) => `mod ${m};`));
  for (const name of MODULES.filter((m) => m !== 'lib')) assert.deepEqual(modsOf(name), [], name);
  const lines = SOURCES.flatMap((f) => code(read(join(tauriDir, f))).split('\n'));
  assert.deepEqual(lines.filter((line) => /include(_str|_bytes)?!|#\[path/.test(line)), []);
});

test('核心里的每个文件只引登记表里写的', () => {
  for (const name of MODULES) {
    const extra = usesOf(name).filter((used) => !USES[name].includes(used));
    assert.deepEqual(extra, [], `${name}.rs 引了没登记的文件`);
    assert.doesNotMatch(code(source(name)), /\bsuper::(?!\*)/, `${name}.rs 用了 super::`);
  }
});

test('登记表没有循环', () => {
  const done = new Set();
  const visiting = new Set();
  const visit = (name, path) => {
    assert.ok(!visiting.has(name), '循环：' + [...path, name].join(' → '));
    if (done.has(name)) return;
    visiting.add(name);
    for (const used of USES[name]) visit(used, [...path, name]);
    visiting.delete(name);
    done.add(name);
  };
  for (const name of MODULES) visit(name, []);
});

test('启动器只用标准库，不引核心的任何文件', () => {
  const text = code(source('launcher'));
  const names = [...MODULES, 'crate', 'serde_json', 'yongle_erp_core'].join('|');
  assert.doesNotMatch(text, new RegExp(`(?<![:\\w])(${names}|tauri\\w*)::|^\\s*mod\\s+\\w+\\s*;`, 'm'));
  const uses = [...text.matchAll(/^use\s+([\w:]+)/gm)].map((m) => m[1].split('::')[0]);
  assert.deepEqual([...new Set(uses)].filter((u) => u !== 'std' && u !== 'super'), []);
});

test('启动器找的入口就是核心导出的那个', () => {
  const exported = [...source('lib').matchAll(/^pub extern "C" fn (\w+)/gm)].map((m) => m[1]);
  const entry = /const ENTRY: &\[u8\] = b"(\w+)\\0";/.exec(source('launcher'))?.[1];
  assert.deepEqual(exported, [entry]);
});

/**
 * 插件源码里往网页注入脚本的写法：初始化脚本（含直接实现 Plugin 的 initialization_script_2）、
 * 在页面上执行脚本（eval）。插件 build.rs 里的 global_api_script_path（window.__TAURI__.插件名）
 * 只在 withGlobalTauri 打开时才编进去，下面“不开任何 IPC 权限”那条守着它关着
 */
const INJECTS = /\b(js_init_script\w*|initialization_script\w*)\b|\.eval\(|\beval_with_callback\b/;
/** 看过源码、只在某个开关打开时才注入脚本的插件：lib.rs 里必须写着关掉它的那一句 */
const SWITCHED_OFF = { 'tauri-plugin-opener': '.open_js_links_on_click(false)' };

/** 每个直接依赖（运行时）的插件的源码文件 */
function pluginSources() {
  const { packages, resolve: graph } = metadata();
  const root = graph.nodes.find((node) => node.id === graph.root);
  return root.deps
    .filter((dep) => dep.dep_kinds.some((k) => k.kind === null))
    .map((dep) => packages.find((p) => p.id === dep.pkg))
    .filter((p) => p.name.startsWith('tauri-plugin-'))
    .map((p) => ({ name: p.name, files: walk(join(dirname(p.manifest_path), 'src')).filter((f) => f.endsWith('.rs')) }));
}

/** Tauri 会读、会合并的配置文件：tauri.conf.json 和测试版、平台版（.json、.json5、Tauri.*.toml） */
const configFiles = () => readdirSync(tauriDir).filter((f) => /^tauri(\.[\w-]+)*\.conf\.json5?$|^Tauri(\.[\w-]+)*\.toml$/i.test(f));

// serde_json 本来就随 tauri 一起编进来；配置里有插件设置（plugins.updater）时 generate_context! 要求直接依赖它
test('运行时只依赖登记过的包', () => {
  assert.deepEqual(directDeps(null), [
    'serde_json',
    'tauri',
    'tauri-plugin-autostart',
    'tauri-plugin-opener',
    'tauri-plugin-single-instance',
    'tauri-plugin-updater',
    'webview2-com',
    'windows-core',
  ]);
});

test('直接用的 WebView2 绑定和 tauri 里用的是同一份，没有引进第二份', () => {
  const { packages } = metadata();
  for (const name of ['webview2-com', 'windows-core']) {
    assert.equal(packages.filter((p) => p.name === name).length, 1, name);
  }
});

test('构建只依赖 tauri-build，没有开发依赖，npm 只有开发用的 Tauri 命令行', () => {
  assert.deepEqual(directDeps('build'), ['tauri-build']);
  assert.deepEqual(directDeps('dev'), []);
  const pkg = JSON.parse(read(join(project, 'package.json')));
  assert.equal(pkg.dependencies, undefined);
  assert.deepEqual(Object.keys(pkg.devDependencies), ['@tauri-apps/cli']);
});

test('pages 里的每个文件都装进安装包', () => {
  const config = JSON.parse(read(join(tauriDir, 'tauri.conf.json')));
  const resources = Object.keys(config.bundle.resources);
  const pages = readdirSync(join(project, 'pages')).map((f) => `../pages/${f}`);
  assert.deepEqual(pages.filter((p) => !resources.includes(p)), []);
});

test('安装包里的页面、配置、图标、钩子都在本目录里', () => {
  const config = JSON.parse(read(join(tauriDir, 'tauri.conf.json')));
  const hooks = config.bundle.windows.nsis.installerHooks;
  const resources = Object.keys(config.bundle.resources);
  const files = [...resources, ...config.bundle.icon, hooks].map((p) => resolve(tauriDir, p));
  for (const file of files) {
    assert.ok(inside(file), `${file} 不在 apps/desktop 里`);
    assert.ok(existsSync(file), `${file} 不存在`);
  }
});

test('不开任何 IPC 权限：各份配置、打包覆盖项、构建脚本、Rust 代码里都没有', () => {
  assert.deepEqual(configFiles().sort(), ['tauri.conf.json', 'tauri.test.conf.json']);
  for (const file of configFiles()) {
    const text = read(join(tauriDir, file));
    assert.doesNotMatch(text, /capabilit/i, `${file} 里写了权限`);
    assert.doesNotMatch(text, /withGlobalTauri\W+true/, `${file} 开了 withGlobalTauri`);
  }
  assert.equal(existsSync(join(tauriDir, 'capabilities')), false);
  assert.doesNotMatch(read(join(project, 'scripts', 'build-test.mjs')), /capabilit|withGlobalTauri/i);
  assert.doesNotMatch(code(read(join(tauriDir, 'build.rs'))), /capabilit|app_manifest|AppManifest|InlinedPlugin/i);
  for (const file of SOURCES) {
    assert.doesNotMatch(code(read(join(tauriDir, file))), /add_capability|invoke_handler|generate_handler/, file);
  }
});

test('编进程序的权限一条都没有（tauri-build 生成的权限清单是空的）', () => {
  const generated = join(tauriDir, 'gen', 'schemas', 'capabilities.json');
  assert.ok(existsSync(generated), '找不到 src-tauri/gen/schemas/capabilities.json：先编译一次');
  assert.deepEqual(JSON.parse(read(generated)), {});
});

test('没有插件往网页注入脚本', () => {
  const plugins = pluginSources();
  assert.deepEqual(
    plugins.map((p) => p.name).sort(),
    directDeps(null).filter((d) => d.startsWith('tauri-plugin-')),
  );
  const lib = source('lib');
  for (const { name, files } of plugins) {
    const injecting = files.filter((f) => INJECTS.test(read(f)));
    if (injecting.length === 0) continue;
    assert.ok(name in SWITCHED_OFF, `${name} 往网页注入脚本：${injecting.join(', ')}`);
    assert.ok(lib.includes(SWITCHED_OFF[name]), `${name} 注入脚本的开关没在 lib.rs 里关掉`);
  }
});

/** 路径 d 里的点（只认绝对坐标的 M、L、H、V、Z；改用别的命令时这里要跟着改） */
function pathPoints(d) {
  assert.match(d, /^[MLHVZ\d.,\s-]+$/, `路径用了没认的命令：${d}`);
  const points = [];
  let last = [0, 0];
  for (const [, cmd, args] of d.matchAll(/([MLHVZ])([^MLHVZ]*)/g)) {
    const nums = args.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    for (let i = 0; i < nums.length; i += cmd === 'H' || cmd === 'V' ? 1 : 2) {
      if (cmd === 'H') last = [nums[i], last[1]];
      else if (cmd === 'V') last = [last[0], nums[i]];
      else last = [nums[i], nums[i + 1]];
      points.push(last);
    }
  }
  return points;
}

/**
 * 启动画面的窗口大小只在 splash.rs 定义。商标（.logo，viewBox 100×100，在窗口里居中）的每组图形
 * 按它动画里每个平移值算出占的范围（窗口坐标，逻辑像素），都要在可见范围里：
 * 商标框不裁（overflow: visible）时是整个窗口，裁的话是商标框
 */
test('启动画面的窗口装得下整段动画', () => {
  const [w, h] = /const SIZE: \(f64, f64\) = \(([\d.]+), ([\d.]+)\);/.exec(source('splash')).slice(1).map(Number);
  const css = read(join(project, 'pages', 'splash.css'));
  const html = read(join(project, 'pages', 'splash.html'));
  assert.match(html, /viewBox="0 0 100 100"/);
  assert.doesNotMatch(css, /shadow|filter|scale|rotate|skew|matrix|translateY|translate\(/, '加了阴影或别的变换：这条检查要跟着算外扩');
  const logo = /\.logo\s*\{([^}]*)\}/.exec(css)[1];
  const size = Number(/width:\s*([\d.]+)px/.exec(logo)[1]);
  assert.equal(Number(/height:\s*([\d.]+)px/.exec(logo)[1]), size);
  const [left, top] = [(w - size) / 2, (h - size) / 2];
  const visible = /overflow:\s*visible/.test(logo) ? [0, 0, w, h] : [left, top, left + size, top + size];
  const shifts = (anim) => {
    const block = new RegExp(`@keyframes ${anim}\\s*\\{([\\s\\S]*?)\\r?\\n\\}`).exec(css)[1];
    return [0, ...[...block.matchAll(/translateX\((-?[\d.]+)px\)/g)].map((m) => Number(m[1]))];
  };
  for (const [, group, body] of html.matchAll(/<g class="(\w+)">([\s\S]*?)<\/g>/g)) {
    const anim = new RegExp(`\\.${group}\\s*\\{[^}]*animation:\\s*([\\w-]+)`).exec(css)[1];
    const points = [...body.matchAll(/ d="([^"]+)"/g)].flatMap((m) => pathPoints(m[1]));
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    for (const dx of shifts(anim)) {
      const scaled = [Math.min(...xs) + dx, Math.min(...ys), Math.max(...xs) + dx, Math.max(...ys)].map((v) => (v * size) / 100);
      const box = [left + scaled[0], top + scaled[1], left + scaled[2], top + scaled[3]];
      const fits = box[0] >= visible[0] && box[1] >= visible[1] && box[2] <= visible[2] && box[3] <= visible[3];
      assert.ok(fits, `${group} 平移 ${dx} 时占 ${box.join(',')}，超出可见范围 ${visible.join(',')}`);
    }
  }
});

test('文本文件都不超过 500 行', () => {
  const text = /\.(rs|mjs|js|json|toml|html|css|md|ps1|svg|nsh)$/;
  const lockfile = /package-lock\.json$|Cargo\.lock$/;
  const tooLong = walk(project)
    .filter((f) => text.test(f) && !lockfile.test(f))
    .filter((f) => lineCount(read(f)) > 500)
    .map((f) => relative(project, f));
  assert.deepEqual(tooLong, []);
});
