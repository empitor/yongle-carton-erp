// npm run check：按顺序跑全部体检，哪一步不过就停下、把那一步的输出打出来。Windows 在开发机上跑；Linux 在服务器上打包前跑测试（docs/运维/打包和客户端更新.md“打包和 Linux 验证”）。
// 每步一行结果；慢测试、低覆盖不达标也拦，那一行后面带上条数。界面流程要浏览器、要几分钟，单独 npm run test:ui。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// 各步就是 package.json 里同名的脚本（一处定义），用调起本脚本的那个 npm 去跑
if (!process.env.npm_execpath) throw new Error('用 npm run check 跑（要靠 npm 调 package.json 里的各个脚本）');
const npm = (script) => [process.execPath, [process.env.npm_execpath, 'run', '--silent', script]];
// 构建只输出到系统临时目录，不碰正在用的 dist；esbuild 的中转文件放项目里的 .build-tmp-*（原因见 scripts/build.mjs）
const out = mkdtempSync(join(tmpdir(), 'erp-check-build-'));
const buildTmp = mkdtempSync(join(root, '.build-tmp-'));

/** pick：成功时这一步的输出里哪些行带到结果行后面 */
const steps = [
  { name: '类型检查', cmd: npm('typecheck') },
  { name: '代码检查', cmd: npm('lint') },
  { name: '函数只许变小', cmd: npm('lint:ratchet') },
  { name: '样式写死的值', cmd: npm('lint:css') },
  { name: '没人用的代码', cmd: npm('knip') },
  { name: '重复代码', cmd: npm('dup') },
  { name: '完整测试', cmd: npm('test'), pick: /^(主套件|单条超过|登记了但)/ },
  { name: '覆盖检查', cmd: npm('test:coverage'), pick: /^(server\/|登记了但)/ },
  { name: '发布检查', cmd: npm('test:release'), pick: /^发布检查/ },
  // package.json 的 build 会覆盖 dist，这里直接调 vite 输出到临时目录（类型检查第一步已做）
  { name: '构建检查', cmd: [process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'warn']], env: { TMP: buildTmp, TEMP: buildTmp } },
];

const run = ([cmd, args], env) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (b) => (text += b));
    child.stderr.on('data', (b) => (text += b));
    child.on('close', (code) => resolve({ ok: code === 0, text }));
  });

const started = Date.now();
let failed = null;
for (const step of steps) {
  const t = Date.now();
  const r = await run(step.cmd, step.env);
  const sec = Math.round((Date.now() - t) / 1000) + ' 秒';
  if (!r.ok) {
    failed = step.name;
    console.log(`✗ ${step.name}（${sec}）没过，输出：\n${r.text.trimEnd()}`);
    break;
  }
  const picked = step.pick ? r.text.split('\n').filter((l) => step.pick.test(l)).map((l) => l.replace(/[:：]\s*$/, '')) : [];
  console.log(`✓ ${step.name}（${sec}）${picked.length ? '  ' + picked.join('；') : ''}`);
}
rmSync(out, { recursive: true, force: true });
rmSync(buildTmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
const total = Math.round((Date.now() - started) / 1000);
console.log(failed ? `体检停在“${failed}”，用了 ${total} 秒。` : `体检全部通过，用了 ${total} 秒。`);
process.exit(failed ? 1 : 0);
