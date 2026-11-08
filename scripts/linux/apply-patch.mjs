// 在服务器上应用 scripts/patch-server.mjs 生成的补丁。由 patch-server 上传后以 root 运行：
//   sudo /opt/yongle-carton-erp/runtime/node/bin/node apply-patch.mjs 补丁.json.gz
// 顺序：校验补丁 → 核对服务器文件仍是比对时的样子 → 备份业务数据 → 保存回滚副本 →
// 停服务 → 替换文件 → 启动 → 检查健康和版本。启动不起来就自动换回旧文件再启动。
// 只用 Node 自带模块，只改程序目录，不碰 data/、backups/、配置和语音模型。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { gunzipSync } from 'node:zlib';

const app = '/opt/yongle-carton-erp';
const service = 'yongle-carton-erp';
const historyRoot = '/var/backups/yongle-carton-erp-patches';
const fail = (message) => {
  console.error('补丁未应用：' + message);
  process.exit(1);
};
if (process.getuid?.() !== 0) fail('需要 root（sudo）运行。');
const patchPath = process.argv[2];
if (!patchPath || !existsSync(patchPath)) fail('找不到补丁文件。');
const patch = JSON.parse(gunzipSync(readFileSync(patchPath)).toString('utf8'));
if (patch.format !== 'yongle-erp-patch/1' || !/^[0-9T]+-[0-9a-f]{8}$/.test(patch.id)) fail('补丁格式不对。');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const target = (path) => {
  const p = normalize(path);
  // 只允许程序目录里的相对路径，补丁里的路径不能跳出去，也不能碰数据和运行时。
  if (p.startsWith('/') || p.startsWith('..') || /^(data|backups|runtime|node_modules|vendor\/models\/sensevoice)(\/|$)/.test(p) || p === '.release-package')
    fail('补丁包含不允许的路径：' + path);
  return join(app, p);
};
const current = (path) => (existsSync(target(path)) ? sha(readFileSync(target(path))) : null);

const installed = JSON.parse(readFileSync(join(app, '.release-package'), 'utf8')).version;
if (patch.fromVersion && installed !== patch.fromVersion && installed !== patch.version)
  fail(`这个补丁用于把 ${patch.fromVersion} 升级到 ${patch.version}，服务器当前是 ${installed}。`);
console.log(`补丁 ${patch.id}：${installed} → ${patch.version}，${patch.files.length} 个文件写入，${patch.deleted.length} 个删除。`);
for (const f of patch.files) {
  if (sha(Buffer.from(f.data, 'base64')) !== f.sha256) fail('补丁内容损坏：' + f.path);
  if (current(f.path) !== f.before) fail('服务器上的文件在比对之后被改过：' + f.path + '。请重新运行补丁脚本。');
}
for (const f of patch.deleted) if (current(f.path) !== f.before) fail('服务器上的文件在比对之后被改过：' + f.path);

const env = Object.fromEntries(
  (existsSync('/etc/yongle-carton-erp/erp.env') ? readFileSync('/etc/yongle-carton-erp/erp.env', 'utf8') : '')
    .split('\n')
    .map((l) => /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(l))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]),
);
const port = env.PORT || '3001';
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', ...opts });

console.log('\n== 备份业务数据');
if (run('runuser', ['-u', 'yongle-erp', '--', join(app, 'scripts/linux/erp.sh'), 'backup']).status !== 0)
  fail('业务数据备份失败，没有改动任何文件。');

console.log('\n== 保存回滚副本');
const history = join(historyRoot, patch.id);
mkdirSync(history, { recursive: true, mode: 0o700 });
const saved = [];
for (const path of [...patch.files.map((f) => f.path), ...patch.deleted.map((f) => f.path)]) {
  const file = target(path);
  saved.push(existsSync(file)
    ? { path, data: readFileSync(file).toString('base64'), mode: statSync(file).mode & 0o777 }
    : { path, data: null });
}
const markerFile = join(app, '.release-package');
const oldMarker = readFileSync(markerFile, 'utf8');
writeFileSync(join(history, 'rollback.json'), JSON.stringify({ marker: oldMarker, files: saved }), { mode: 0o600 });
writeFileSync(join(history, 'patch.json.gz'), readFileSync(patchPath), { mode: 0o600 });
console.log('回滚副本：' + history);

const write = (path, data, mode) => {
  const file = target(path);
  const dir = dirname(file);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chownSync(dir, 0, 0);
  }
  const temp = file + '.patch-tmp';
  writeFileSync(temp, data);
  chownSync(temp, 0, 0);
  chmodSync(temp, mode);
  renameSync(temp, file);
};
const health = () => {
  // 最多约 90 秒：30 次，每次最多等 2 秒再歇 1 秒。
  for (let i = 0; i < 30; i++) {
    const r = spawnSync('curl', ['-fsS', '--max-time', '2', `http://127.0.0.1:${port}/api/health`], { encoding: 'utf8' });
    if (r.status === 0) {
      try {
        return JSON.parse(r.stdout);
      } catch {}
    }
    spawnSync('sleep', ['1']);
  }
  return null;
};
const rollback = (reason) => {
  console.error('\n== 回滚：' + reason);
  run('systemctl', ['stop', service]);
  for (const f of saved) {
    if (f.data === null) rmSync(target(f.path), { force: true });
    else write(f.path, Buffer.from(f.data, 'base64'), f.mode);
  }
  writeFileSync(markerFile, oldMarker);
  run('systemctl', ['start', service]);
  console.error(health() ? '已换回旧文件，服务已恢复。' : '已换回旧文件，但服务没有起来，请查看 journalctl -u ' + service);
  process.exit(1);
};

console.log('\n== 停止服务并替换文件');
if (run('systemctl', ['stop', service]).status !== 0) fail('停止服务失败，没有改动任何文件。');
try {
  for (const f of patch.files) {
    const file = target(f.path);
    const mode = existsSync(file) ? statSync(file).mode & 0o777 : /\.sh$/.test(f.path) ? 0o755 : 0o644;
    write(f.path, Buffer.from(f.data, 'base64'), mode);
  }
  for (const f of patch.deleted) rmSync(target(f.path), { force: true });
  const marker = JSON.parse(oldMarker);
  // 当前程序对应的提交和是否正式发布，patch-server --check 据此核对三方一致。
  const released = patch.released ?? !patch.dirty;
  marker.version = patch.version;
  marker.commit = patch.baseCommit;
  marker.released = released;
  marker.patches = [
    ...(marker.patches || []),
    {
      id: patch.id,
      appliedAt: new Date().toISOString(),
      baseCommit: patch.baseCommit,
      dirty: patch.dirty,
      released,
      ...(patch.hotfix ? { hotfix: patch.hotfix } : {}),
      written: patch.files.length,
      deleted: patch.deleted.length,
    },
  ];
  writeFileSync(markerFile, JSON.stringify(marker, null, 2) + '\n');
} catch (error) {
  rollback('替换文件出错：' + error.message);
}

console.log('\n== 启动并检查');
if (run('systemctl', ['start', service]).status !== 0) rollback('服务启动失败');
const state = health();
if (!state) rollback('启动后 90 秒内健康检查没有通过');
if (state.version !== patch.version) rollback(`健康检查版本是 ${state.version}，应为 ${patch.version}`);
rmSync(patchPath, { force: true });
console.log(`\n补丁已应用：版本 ${state.version}，进程 ${state.processId}。回滚副本留在 ${history}。`);
if (patch.hotfix) console.log(`这是临时修复（${patch.hotfix}），已标记为未发布，事后要补发正式版本。`);
