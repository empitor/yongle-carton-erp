// 小版本升级服务器：只传有变化的程序文件，不传整包。大版本或依赖变了仍用整包。
// 原则：服务器上跑的代码必须是 GitHub 上某个已发布版本的代码，本机、GitHub、服务器三方一致。
// 用法：npm run patch-server -- [--host yongle-erp] [--dry-run | --check | --hotfix "原因"]
//   默认：正式打补丁。要求本机没有未提交的改动、当前提交打了 v版本号 标签、标签已推送到 GitHub。
//   --dry-run 只对比、列出差异，不上传、不改服务器。
//   --check 核对本机、GitHub、服务器三方的版本、提交和每个程序文件，不一致时退出码为 1。
//   --hotfix "原因" 紧急临时修复：跳过发布检查直接打上去，服务器标记为“临时修复，未发布”，事后必须补发正式版本。
// 生成发布用补丁（例如 0.8.2 → 0.8.3，附到 GitHub Release）：
//   npm run patch-server -- --base 服务器上解压好的旧版安装目录 --out 本机输出目录
//   只和 --base 目录比对、生成补丁文件和 apply-patch.mjs，不上传、不改服务器。
// 流程：本机类型检查并构建页面 → 和服务器逐个文件比对 sha256 → 打补丁上传 →
// 服务器上备份数据、留回滚副本、替换文件、重启、检查健康，失败自动回滚 → 再比对一次，确认一致。
// 只动程序目录，不碰服务器的 data/、backups/、配置和语音模型。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { releaseFiles } from './release-files.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const host = arg('--host') || 'yongle-erp';
const dryRun = process.argv.includes('--dry-run');
const installRoot = '/opt/yongle-carton-erp';
// 比对基准：默认是服务器上正在运行的程序目录；发布补丁时换成解压好的旧版安装包。
const appRoot = arg('--base') || installRoot;
const outDir = arg('--out') ? resolve(arg('--out')) : undefined;
if (!/^\/[\w./-]+$/.test(appRoot)) throw new Error('--base 要写服务器上的绝对路径。');
if (arg('--base') && !outDir) throw new Error('--base 只用于生成发布补丁，要和 --out 一起用。');
const checkOnly = process.argv.includes('--check');
const hotfixFlag = process.argv.includes('--hotfix');
const hotfix = hotfixFlag ? arg('--hotfix') : undefined;
if (hotfixFlag && (!hotfix || hotfix.startsWith('--')))
  throw new Error('--hotfix 后面要写原因，例如 --hotfix "登录页打不开，先临时修复"。');
if (hotfixFlag && (outDir || checkOnly || dryRun)) throw new Error('--hotfix 只用于直接给服务器打补丁。');
if (checkOnly && (outDir || dryRun)) throw new Error('--check 不能和 --out、--dry-run 一起用。');
const remoteDir = '/home/ubuntu/erp-patches';
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const scope = releaseFiles(pkg.version);
const step = (text) => console.log('\n== ' + text);
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const short = (commit) => (commit ? commit.slice(0, 7) : '无');

// 发布检查：本机工作区干净、当前提交打了 v版本号 标签、GitHub 上的同名标签指向同一个提交。
const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
const tagName = 'v' + pkg.version;
function gitState() {
  const state = {
    head: git('rev-parse', 'HEAD').stdout.trim(),
    clean: !git('status', '--porcelain').stdout.trim(),
    localTag: git('rev-parse', '-q', '--verify', `refs/tags/${tagName}^{commit}`).stdout.trim() || null,
    remoteTag: null,
    remoteMain: null,
    remoteError: null,
  };
  const refs = (args) => {
    const r = git('ls-remote', ...args);
    if (r.status !== 0) {
      state.remoteError = (r.stderr || '').trim() || '无法访问 GitHub';
      return new Map();
    }
    return new Map(r.stdout.trim().split('\n').filter(Boolean).map((l) => l.split('\t').reverse()));
  };
  // 附注标签要取 ^{} 那一行才是它指向的提交；这一行要单独写进查询条件才会返回。
  const tags = refs(['origin', `refs/tags/${tagName}`, `refs/tags/${tagName}^{}`]);
  state.remoteTag = tags.get(`refs/tags/${tagName}^{}`) || tags.get(`refs/tags/${tagName}`) || null;
  if (!state.remoteError) state.remoteMain = refs(['--heads', 'origin', 'main']).get('refs/heads/main') || null;
  return state;
}
function releaseProblems(s) {
  const problems = [];
  if (!s.clean) problems.push('本机有未提交的改动（用 git status 查看），先提交。');
  if (!s.localTag) problems.push(`本机没有 ${tagName} 标签。确认版本号后打标签：git tag -a ${tagName} -m "说明"`);
  else if (s.localTag !== s.head)
    problems.push(`${tagName} 标签指向 ${short(s.localTag)}，当前提交是 ${short(s.head)}。修了新东西要先改版本号再打新标签。`);
  if (s.remoteError) problems.push('访问 GitHub 失败：' + s.remoteError);
  else if (!s.remoteTag) problems.push(`${tagName} 还没推送到 GitHub：git push origin main ${tagName}`);
  else if (s.remoteTag !== s.head) problems.push(`GitHub 上的 ${tagName} 指向 ${short(s.remoteTag)}，和本机当前提交 ${short(s.head)} 不同。`);
  return problems;
}

// 本机是 Windows 换行，服务器上是 Git 取出的 LF；按 .gitattributes 的规则转换，.cmd 保持 CRLF。
const textExt = /\.(ts|tsx|mjs|cjs|js|json|md|sh|css|html|txt|ps1|svg|example|service|yml|yaml|map)$|(^|\/)LICENSE$/i;
function normalized(path, bytes) {
  if (/\.cmd$/i.test(path) || !textExt.test(path) || bytes.includes(0)) return bytes;
  return Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}
function walk(base, rel, out) {
  const full = join(base, rel);
  if (!existsSync(full)) throw new Error('缺少程序文件：' + rel);
  if (statSync(full).isDirectory()) {
    for (const name of readdirSync(full)) walk(base, rel + '/' + name, out);
  } else out.set(rel, normalized(rel, readFileSync(full)));
}
function ssh(script, { allowFail = false } = {}) {
  const r = spawnSync('ssh', [host, 'sh -s'], { input: script, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) throw new Error('服务器命令失败：' + (r.stderr || r.stdout || r.error?.message));
  return r;
}
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
function remoteManifest() {
  const items = [...scope, 'dist'].map(quote).join(' ');
  const out = ssh(
    `set -e; cd ${appRoot}\nfor p in ${items}; do if [ -e "$p" ]; then find "$p" -type f; fi; done | tr '\\n' '\\0' | xargs -0 -r sha256sum\n`,
  ).stdout;
  const map = new Map();
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (m) map.set(m[2], m[1]);
  }
  return map;
}
function diff(local, remote) {
  const changed = [], added = [], deleted = [];
  for (const [path, bytes] of local) {
    const before = remote.get(path);
    if (before === undefined) added.push(path);
    else if (before !== sha(bytes)) changed.push(path);
  }
  for (const path of remote.keys()) if (!local.has(path)) deleted.push(path);
  return { changed: changed.sort(), added: added.sort(), deleted: deleted.sort() };
}

step('检查环境');
if (!existsSync(join(root, 'node_modules/vite/bin/vite.js'))) throw new Error('本机缺少依赖，先运行 npm ci。');
const marker = ssh(`cat ${appRoot}/.release-package`, { allowFail: true });
if (marker.status !== 0) throw new Error('服务器上没有找到已安装的程序：' + appRoot + '。第一次安装请用整包。');
const serverMarker = JSON.parse(marker.stdout);
const fromVersion = serverMarker.version;
console.log((outDir ? '比对基准：' : '服务器当前：') + '版本 ' + fromVersion);
if (outDir && appRoot === installRoot) throw new Error('生成发布补丁要用 --base 指定解压好的旧版安装目录，不能拿正在运行的服务器当基准。');

step('发布检查');
const state = gitState();
const problems = releaseProblems(state);
console.log(`本机：版本 ${pkg.version}，提交 ${short(state.head)}，${state.clean ? '没有未提交的改动' : '有未提交的改动'}`);
console.log(`GitHub：${tagName} → ${state.remoteError ? '无法访问' : short(state.remoteTag)}，main → ${state.remoteError ? '无法访问' : short(state.remoteMain)}`);
if (!problems.length) console.log('通过：本机代码就是 GitHub 上已发布的 ' + tagName + '。');
else if (dryRun || checkOnly) for (const p of problems) console.log('注意：' + p);
else if (hotfix) {
  for (const p of problems) console.warn('跳过：' + p);
  console.warn(`临时修复（${hotfix}）：服务器会标记为未发布，事后必须补发正式版本。`);
} else
  throw new Error(
    '不能打补丁：本机代码还不是 GitHub 上一个已发布的版本。\n- ' +
      problems.join('\n- ') +
      '\n服务器出了紧急问题、必须先修上去时，可以加 --hotfix "原因"，事后必须补发正式版本。',
  );

step('类型检查和构建页面');
const buildTemp = mkdtempSync(join(root, '.build-tmp-'));
const distDir = mkdtempSync(join(tmpdir(), 'erp-patch-dist-'));
const local = new Map();
try {
  const env = { ...process.env, TMP: buildTemp, TEMP: buildTemp };
  const checked = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit'], { cwd: root, stdio: 'inherit', env });
  if (checked.status !== 0) throw new Error('类型检查失败，不打补丁。');
  const built = spawnSync(
    process.execPath,
    [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', distDir, '--emptyOutDir', '--configLoader', 'runner', '--logLevel', 'warn'],
    { cwd: root, stdio: 'inherit', env },
  );
  if (built.status !== 0) throw new Error('页面构建失败，不打补丁。');
  for (const item of scope) walk(root, item, local);
  const dist = new Map();
  walk(distDir, '.', dist);
  for (const [path, bytes] of dist) local.set('dist/' + path.slice(2), bytes);
} finally {
  rmSync(buildTemp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(distDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

step('和服务器逐个比对');
const remote = remoteManifest();
const d = diff(local, remote);
const total = d.changed.length + d.added.length + d.deleted.length;
for (const [label, list] of [['修改', d.changed], ['新增', d.added], ['删除', d.deleted]])
  for (const path of list) console.log(label + '  ' + path);
console.log(`共 ${local.size} 个程序文件，${d.changed.length} 个修改、${d.added.length} 个新增、${d.deleted.length} 个删除。`);
if (checkOnly) {
  step('三方核对结果');
  const last = serverMarker.patches?.at(-1);
  const serverCommit = serverMarker.commit || (last ? last.baseCommit : serverMarker.baseCommit);
  const serverReleased = serverMarker.released ?? (last ? !last.dirty && !last.hotfix : true);
  console.log(`服务器：版本 ${fromVersion}，提交 ${short(serverCommit)}，${serverReleased ? '正式发布' : '临时修复或含未提交的改动'}${last ? `，最近一次补丁 ${last.id}` : ''}`);
  const issues = [
    ...problems,
    ...(fromVersion !== pkg.version ? [`服务器版本是 ${fromVersion}，本机是 ${pkg.version}。`] : []),
    ...(serverCommit !== state.head ? [`服务器记录的提交是 ${short(serverCommit)}，本机是 ${short(state.head)}。`] : []),
    ...(!serverReleased ? ['服务器上是临时修复或含未提交的改动，要补发正式版本。'] : []),
    ...(total ? [`服务器上有 ${total} 个程序文件和本机不同。`] : []),
  ];
  if (!issues.length) {
    console.log(`一致：本机、GitHub、服务器都是 ${tagName}（${short(state.head)}），${local.size} 个程序文件完全相同。`);
    process.exit(0);
  }
  console.log('不一致：\n- ' + issues.join('\n- '));
  process.exit(1);
}
if (!total) {
  console.log('服务器上的程序已经和本机一致，不用打补丁。');
  process.exit(0);
}
// 依赖变了要重新安装原生模块，补丁做不了。锁文件里只有版本号变了（发版）不算。
if (d.added.includes('package-lock.json')) throw new Error('服务器上没有 package-lock.json，请用整包升级。');
if (d.changed.includes('package-lock.json')) {
  const strip = (lock) => {
    const copy = structuredClone(lock);
    delete copy.version;
    if (copy.packages?.['']) delete copy.packages[''].version;
    return JSON.stringify(copy);
  };
  const theirs = JSON.parse(ssh(`cat ${appRoot}/package-lock.json`).stdout);
  if (strip(theirs) !== strip(JSON.parse(local.get('package-lock.json').toString('utf8'))))
    throw new Error('package-lock.json 里的依赖变了，补丁不能安装依赖，请用整包升级。');
}
if (d.changed.includes('package.json')) {
  const theirs = JSON.parse(ssh(`cat ${appRoot}/package.json`).stdout);
  const deps = (p) => JSON.stringify([p.dependencies, p.optionalDependencies, p.overrides, p.engines]);
  if (deps(theirs) !== deps(pkg)) throw new Error('package.json 里的依赖变了，请用整包升级。');
}
if (dryRun) {
  console.log('\n只对比（--dry-run），没有上传，服务器没动。');
  process.exit(0);
}

step('打补丁');
const baseCommit = state.head || 'unknown';
const dirty = !state.clean;
const files = [...d.changed, ...d.added].map((path) => {
  const bytes = local.get(path);
  return { path, sha256: sha(bytes), before: remote.get(path) ?? null, data: bytes.toString('base64') };
});
const body = {
  format: 'yongle-erp-patch/1',
  createdAt: new Date().toISOString(),
  version: pkg.version,
  fromVersion,
  baseCommit,
  dirty,
  // 正式发布 = 没有未提交改动、不是临时修复，且通过了上面的发布检查。
  released: !problems.length && !hotfix,
  hotfix: hotfix || null,
  files,
  deleted: d.deleted.map((path) => ({ path, before: remote.get(path) })),
};
const id = body.createdAt.replace(/[-:]/g, '').replace(/\..+$/, '') + '-' + sha(JSON.stringify(body)).slice(0, 8);
body.id = id;
const work = mkdtempSync(join(tmpdir(), 'erp-patch-'));
const patchFile = join(work, id + '.json.gz');
const applyFile = join(work, 'apply-patch.mjs');
writeFileSync(patchFile, gzipSync(JSON.stringify(body)));
writeFileSync(applyFile, normalized('apply-patch.mjs', readFileSync(join(root, 'scripts/linux/apply-patch.mjs'))));
console.log(`补丁 ${id}：${(statSync(patchFile).size / 1024).toFixed(0)} KB`);

if (outDir) {
  // 发布补丁：只输出文件，不上传、不改服务器。
  mkdirSync(outDir, { recursive: true });
  const name = `yongle-carton-erp-v${fromVersion}-to-v${pkg.version}-linux-x64.patch.json.gz`;
  const outputs = [[patchFile, name], [applyFile, 'apply-patch.mjs']];
  for (const [from, to] of outputs) {
    const bytes = readFileSync(from);
    writeFileSync(join(outDir, to), bytes);
    writeFileSync(join(outDir, to + '.sha256'), `${sha(bytes)}  ${to}\n`);
    console.log(`${join(outDir, to)}  sha256 ${sha(bytes)}`);
  }
  rmSync(work, { recursive: true, force: true });
  console.log(`\n发布补丁已生成：${fromVersion} → ${pkg.version}，基线 ${baseCommit.slice(0, 7)}${dirty ? '（含未提交的改动）' : ''}。服务器没动。`);
  process.exit(0);
}

step('上传并在服务器上应用');
try {
  ssh(`mkdir -p ${remoteDir} && chmod 700 ${remoteDir}`);
  for (const f of [patchFile, applyFile]) {
    const r = spawnSync('scp', ['-q', f, `${host}:${remoteDir}/`], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('上传失败：' + relative(work, f));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
const applied = spawnSync(
  'ssh',
  [host, `sudo ${installRoot}/runtime/node/bin/node ${remoteDir}/apply-patch.mjs ${remoteDir}/${id}.json.gz`],
  { stdio: 'inherit' },
);
if (applied.status !== 0) throw new Error('服务器应用补丁失败，详情见上面的输出。');

step('再次比对，确认和本机一致');
const after = diff(local, remoteManifest());
const left = [...after.changed, ...after.added, ...after.deleted];
if (left.length) throw new Error('补丁后仍有差异：\n' + left.join('\n'));
console.log(`一致：服务器上 ${local.size} 个程序文件和本机完全相同。基线 ${baseCommit.slice(0, 7)}。`);
console.log(
  body.released
    ? `服务器现在就是 GitHub 上的 ${tagName}。`
    : `注意：这是临时修复（${hotfix}），服务器标记为未发布。修好后提交、打新版本标签、推送，再正式打一次补丁。`,
);
