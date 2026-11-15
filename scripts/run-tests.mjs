// npm test：把测试文件分成几组同时跑，每组一个进程、模块只加载一次（--test-isolation=none）。
// 每个文件一个进程的话，光加载服务端代码就占总用时的三分之二。
// 分组按上次实测的每份文件用时装箱（记在 node_modules/.cache，每次跑完更新，见 test-report.mjs）。
// 同一组里的文件共用一个进程：测试改了全局状态（process.env、process.cwd、模块级缓存）要自己恢复。
//
// 用法：
//   npm test                         主套件 + 串行组
//   npm test -- tests/a.test.ts      只跑这几个文件
//   npm run test:isolated            每个文件一个进程，慢但互不影响；怀疑文件之间互相影响时对照
//   npm run test:release             发布前检查（tests/release/）
//   npm run test:coverage            带覆盖统计跑主套件，列出 server/、shared/ 里行覆盖低于 80% 又没登记原因的文件，有就失败（test-coverage.mjs）
//   TEST_JOBS=4 npm test             分几组（默认按 CPU 数，最多 8）
//
// 不管调用方设没设，测试进程的本机数据目录（Windows 的 LOCALAPPDATA）、配置目录（ERP_CONFIG_DIR、
// Linux 的 XDG_CONFIG_HOME）都指向一个新建的临时目录，跑完删掉，碰不到本机真实的程序数据和凭据。
// 默认的业务库路径（DB_PATH）和备份目录（ERP_BACKUP_DIR）也指进去：哪条测试忘了传路径，打开的也是临时目录里的空库，不是项目里的真实数据。
//
// 主套件跑完查单条超过 1 秒、没在 scripts/test-exemptions.mjs 登记原因的测试，有就失败（发布检查起命令行，慢是应该的，不查）。
// 并行时越线的先单独重跑所在文件再下结论，单独跑也超才算慢（test-slow.mjs）。
import { spawn } from 'node:child_process';
import { availableParallelism, tmpdir } from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTimings, packShards, readRecords, saveTimings } from './test-report.mjs';
import { checkSlow, namePattern } from './test-slow.mjs';
import { reportCoverage } from './test-coverage.mjs';
import { lowCoverage, slowTests } from './test-exemptions.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const isolated = args.includes('--isolated'),
  release = args.includes('--release'),
  coverage = args.includes('--coverage');
const list = (dir, re) =>
  readdirSync(join(root, dir))
    .filter((f) => re.test(f))
    .map((f) => dir + '/' + f);
const picked = args.filter((a) => !a.startsWith('-'));
const files = picked.length
  ? picked.filter((f) => !f.includes('/serial/'))
  : list(release ? 'tests/release' : 'tests', /\.test\.(ts|mjs)$/);
const serial = picked.length
  ? picked.filter((f) => f.includes('/serial/'))
  : release
    ? []
    : list('tests/serial', /\.test\.mjs$/);
const jobs = Math.max(1, Math.min(files.length, Number(process.env.TEST_JOBS) || Math.min(8, availableParallelism() - 1)));

const timings = loadTimings(root);
const shards = packShards(files, timings, jobs);

const started = Date.now();
const sandbox = mkdtempSync(join(tmpdir(), 'erp-test-env-'));
for (const d of ['localappdata', 'config', 'xdg', 'data', 'backups']) mkdirSync(join(sandbox, d));
const env = {
  ...process.env,
  LOCALAPPDATA: join(sandbox, 'localappdata'),
  ERP_CONFIG_DIR: join(sandbox, 'config'),
  XDG_CONFIG_HOME: join(sandbox, 'xdg'),
  DB_PATH: join(sandbox, 'data', 'erp.sqlite'),
  ERP_BACKUP_DIR: join(sandbox, 'backups'),
};
const run = (testArgs, quiet) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...testArgs], {
      cwd: root,
      env,
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let text = '';
    child.stdout?.on('data', (b) => (text += b));
    child.stderr?.on('data', (b) => (text += b));
    // 被系统杀掉（内存不足、外部强杀）时 code 是 null，也算失败：没跑完的用例不能当成通过
    child.on('close', (code, signal) => resolve({ ok: code === 0, code, signal, text }));
  });
const finish = (status) => {
  rmSync(sandbox, { recursive: true, force: true });
  process.exit(status);
};
const count = (text, key) => Number(text.match(new RegExp('^ℹ ' + key + ' (\\d+)', 'm'))?.[1] || 0);

let results;
// 每组两个报告器：spec 给人看（只在出错时打出来），test-reporter.mjs 写每条测试的用时（带覆盖跑时换成 lcov）
const timingLog = (i) => join(sandbox, `timings-${i}.jsonl`);
const lcov = (i) => join(sandbox, `coverage-${i}.lcov`);
// 带覆盖跑时测试变慢，不记用时、不查慢测试，改写 lcov
const reporters = (i) => [
  '--test-reporter=spec',
  '--test-reporter-destination=stdout',
  ...(coverage
    ? ['--experimental-test-coverage', '--test-coverage-include=server/**', '--test-coverage-include=shared/**', '--test-reporter=lcov', '--test-reporter-destination=' + lcov(i)]
    : ['--test-reporter=./scripts/test-reporter.mjs', '--test-reporter-destination=' + timingLog(i)]),
];
if (isolated) results = [await run(files, false)];
else results = await Promise.all(shards.map((s, i) => run(['--test-isolation=none', ...reporters(i), ...s.files], true)));
const records = isolated ? [] : shards.flatMap((_, i) => readRecords(timingLog(i)));
if (records.length) saveTimings(root, timings, records);
const failed = results.filter((r) => !r.ok);
if (!isolated) {
  const total = { tests: 0, pass: 0, fail: 0, skipped: 0, cancelled: 0 };
  for (const r of results) for (const k of Object.keys(total)) total[k] += count(r.text, k);
  // 只把出错的那组的完整输出打出来，通过的组只报数
  for (const r of failed) process.stdout.write(r.text + (r.signal ? `\n这一组进程被 ${r.signal} 终止，没跑完。\n` : ''));
  console.log(
    `${release ? '发布检查' : '主套件'}：${files.length} 个文件分 ${results.length} 组，${total.tests} 条，通过 ${total.pass}，失败 ${total.fail}，跳过 ${total.skipped}` +
      (total.cancelled ? `，中断 ${total.cancelled}` : '') +
      (failed.length ? `，${failed.length} 组没有正常结束` : '') +
      `，用了 ${Math.round((Date.now() - started) / 1000)} 秒`,
  );
}
// 带覆盖跑时有测试没过也先把覆盖报出来（测试没过照样算失败）；覆盖检查只跑主套件，不跑串行组
const lowFiles = coverage ? reportCoverage(root, shards.map((_, i) => (existsSync(lcov(i)) ? readFileSync(lcov(i), 'utf8') : '')), lowCoverage) : 0;
if (failed.length) finish(1);
if (coverage) finish(lowFiles ? 1 : 0);
// 单独重跑一份文件里的几条：一个进程、别的文件都不跑，只记用时
const rerunAlone = async (file, names) => {
  const log = join(sandbox, `alone-${file.replaceAll('/', '_')}.jsonl`);
  await run(['--test-isolation=none', '--test-reporter=./scripts/test-reporter.mjs', '--test-reporter-destination=' + log, ...names.map((n) => '--test-name-pattern=' + namePattern(n)), file], true);
  return readRecords(log);
};
if (!isolated && !release) {
  const checkStarted = Date.now();
  const slowCount = await checkSlow(records, slowTests, rerunAlone);
  console.log(`查慢测试用了 ${Math.round((Date.now() - checkStarted) / 1000)} 秒`);
  // 1 秒这条线是按开发机定的；持续集成的机器慢好几倍，在那边只报不拦（CI 由 GitHub Actions 设）
  if (slowCount && process.env.CI) console.log('持续集成的机器比开发机慢，慢测试在这里只报不拦；本机 npm test 照旧拦。');
  else if (slowCount) finish(1);
}
// 串行组会起真实进程、占端口，不和别的测试同时跑
if (serial.length) {
  const s = await run(serial, false);
  if (!s.ok) finish(1);
}
finish(0);
