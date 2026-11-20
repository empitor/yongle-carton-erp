// 应用内更新的本机测试（不发布、不上传、不碰正式服务器）：
//   node scripts/update-test.mjs build <ERP 测试网址> [输出目录]
//     用测试签名密钥（没有就生成，放在 %LOCALAPPDATA%\YongleToolchains\desktop-update-test\，不进仓库）
//     打旧版（tauri.conf.json 的版本号）和新版（次版本号加 1）两个测试安装包，新版带签名，写好版本清单 latest.json。
//   node scripts/update-test.mjs serve [输出目录]
//     在 127.0.0.1:8789 提供版本清单和新版安装包（测试版的清单地址就是这里），Ctrl+C 结束。
// 正式发布的签名和清单做法见 docs/构建与测试.md“应用内更新”。
import { spawnSync } from 'node:child_process';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8789;
const MANIFEST_URL = `http://127.0.0.1:${PORT}/latest.json`;
const project = fileURLToPath(new URL('..', import.meta.url));
const [mode, ...rest] = process.argv.slice(2);
const outDir = (mode === 'build' ? rest[1] : rest[0]) ?? join(tmpdir(), 'yongle-desktop-update-test');
const site = join(outDir, 'site');

function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: project, env: { ...process.env, ...env }, shell: true, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 没成功`);
}

/** 测试签名密钥：只给本机测试用，放在工具目录里 */
function testKey() {
  const dir = join(process.env.LOCALAPPDATA ?? tmpdir(), 'YongleToolchains', 'desktop-update-test');
  const key = join(dir, 'test.key');
  if (!existsSync(key)) {
    mkdirSync(dir, { recursive: true });
    run('npx', ['tauri', 'signer', 'generate', '--ci', '-p', '""', '-w', `"${key}"`]);
  }
  return { privateKey: readFileSync(key, 'utf8'), publicKey: readFileSync(key + '.pub', 'utf8') };
}

function build(url, version, key) {
  run('node', ['scripts/build-test.mjs', url, '--updater', '--version', version], {
    TAURI_SIGNING_PRIVATE_KEY: key.privateKey,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
    ERP_UPDATE_URL: MANIFEST_URL,
    ERP_UPDATE_PUBKEY: key.publicKey,
  });
  const nsis = join(project, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
  const setup = join(nsis, `甬勒ERP测试_${version}_x64-setup.exe`);
  const target = join(outDir, `yongle-erp-test-${version}-setup.exe`);
  copyFileSync(setup, target);
  copyFileSync(setup + '.sig', target + '.sig');
  return target;
}

function buildBoth(url) {
  if (!url) throw new Error('用法：node scripts/update-test.mjs build <ERP 测试网址> [输出目录]');
  mkdirSync(site, { recursive: true });
  const key = testKey();
  const current = JSON.parse(readFileSync(join(project, 'src-tauri', 'tauri.conf.json'), 'utf8')).version;
  const [major, minor] = current.split('.').map(Number);
  const next = `${major}.${minor + 1}.0`;
  const old = build(url, current, key);
  const fresh = build(url, next, key);
  copyFileSync(fresh, join(site, basename(fresh)));
  const manifest = {
    version: next,
    notes: '测试用的新版本：和旧版只差版本号。',
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64': {
        signature: readFileSync(fresh + '.sig', 'utf8'),
        url: `http://127.0.0.1:${PORT}/${basename(fresh)}`,
      },
    },
  };
  writeFileSync(join(site, 'latest.json'), JSON.stringify(manifest, null, 2));
  console.log(`旧版安装包（先装这个）：${old}\n新版安装包：${join(site, basename(fresh))}\n版本清单：${join(site, 'latest.json')}`);
}

function serve() {
  if (!existsSync(join(site, 'latest.json'))) throw new Error(`没找到 ${join(site, 'latest.json')}，先跑 build`);
  createServer((req, res) => {
    const name = normalize(decodeURIComponent(new URL(req.url ?? '/', MANIFEST_URL).pathname)).replace(/^[\\/]+/, '');
    const file = join(site, name);
    if (name.includes('..') || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    console.log(req.method, req.url);
    res.writeHead(200, { 'Content-Type': name.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
    createReadStream(file).pipe(res);
  }).listen(PORT, '127.0.0.1', () => console.log(`版本清单：${MANIFEST_URL}（Ctrl+C 结束）`));
}

if (mode === 'build') buildBoth(rest[0]);
else if (mode === 'serve') serve();
else console.error('用法：node scripts/update-test.mjs build <ERP 测试网址> [输出目录] | serve [输出目录]');
