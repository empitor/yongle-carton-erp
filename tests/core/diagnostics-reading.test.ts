// 排查用的只读诊断：打码、运行日志、读程序代码的范围，以及“交给模型的读取结果里不出现机密”的总扫描。
// 全部用临时目录和 :memory: 库、虚构内容；读程序代码用临时目录拼的假程序目录，不读真实的数据、备份、配置目录。
import { pageActor } from '../support/actor-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  backupDirectory,
  configDirectory,
  defaultDbPath,
  type Actor,
  type AppError,
  redactSecrets,
  ProblemLog,
  readRecentProblems,
} from '../../server/core/index.js';
import { programSource } from '../../server/system/paths.js';
import { AuthManager } from '../../server/accounts/index.js';
import { RunLog, captureProcessOutput, readRunLog, searchRunLog } from '../../server/system/run-log.js';
import { readProgramSource, searchProgramSource } from '../../server/system/source-reader.js';
import { resolveSourcePath, type SourceScope } from '../../server/system/source-paths.js';
import { readLoginRecords } from '../../server/accounts/index.js';

const boss: Actor = pageActor({ id: 'a1', name: '虚构管理员', permissions: [], role: 'super_admin' });
const clerk: Actor = pageActor({ id: 's1', name: '虚构业务员', permissions: ['business:edit'], role: 'admin' });
const hex64 = 'ab12'.repeat(16);

test('打码：口令、令牌、密钥、页面凭证、会话、网址里的账号口令都遮掉，编号和普通文字不动', () => {
  const cases: [string, string][] = [
    ['password=Fictional-pass-1 next', 'password=*** next'],
    ['{"apiKey":"sk-fictional"}', '{"apiKey":***}'],
    ['密码：虚构口令123', '密码：***'],
    ['Authorization: Bearer abcdefghijklmnop', 'Authorization: ***'],
    ['header Bearer abcdefghijklmnop end', 'header Bearer *** end'],
    ['用 sk-abcdefghijklmnop1234 调用', '用 *** 调用'],
    ['cookie erp_session=' + hex64, 'cookie erp_session=***'],
    ['凭证 ' + hex64, '凭证 ***'],
    ['连 https://user:Fictional@db.example.com/x', '连 https://***@db.example.com/x'],
  ];
  for (const [input, expected] of cases) assert.equal(redactSecrets(input), expected, input);
  // 安全审查（低-2）找出来漏过的样子：每条打码后都不能再带原来的机密
  const leaked: [string, RegExp][] = [
    ['aes: Qx7/9fK2mZ1pLw3/Tn8vB5cR0yH/6dJ4sG2aXe9/uI=', /Tn8vB5cR0yH|9fK2mZ1p/],
    ['用户说新密码是 Zx81-kkq7 请记一下', /Zx81/],
    ['口令为 虚构口令9 请记一下', /虚构口令9/],
    ['GET https://api.vendor.example/v1/send?key=Ab12Cd34Ef56&to=1', /Ab12Cd34/],
    ['callback https://erp.example/cb?code=4f9c2d7a1b3e5f60&state=1', /4f9c2d7a/],
    ['https://files.example/get?id=7&sign=9aF3kLm2Qw8ZxC1v', /9aF3kLm2/],
    ['Cookie: theme=dark; sid=k3J9xQ2mV7pL0aZ4', /k3J9xQ2m|theme=dark/],
    ['credential=Hq72mmP0 passphrase: open-sesame-77', /Hq72mmP0|open-sesame/],
    ['signature=ZZ9yy8xx otp: 123456', /ZZ9yy8xx|123456/],
    ['验证码：829417', /829417/],
    ['tokenless ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn', /ABCDEFGHIJ/],
    ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC/BKcwggSjAgEAAoIBAQC7', /BKcwggSj|MIIEvQIB/],
  ];
  for (const [input, secret] of leaked) assert.doesNotMatch(redactSecrets(input), secret, input);
  // 短名字单独成词才遮：错误码、路径不受影响
  for (const kept of ['errcode=19', 'server/core/diagnostics/request-recorder', 'monkey patch'])
    assert.equal(redactSecrets(kept), kept);
  const plain = '订单 550e8400-e29b-41d4-a716-446655440000 保存失败：server/flow/service.ts:120';
  assert.equal(redactSecrets(plain), plain);
});

test('运行日志：写入前打码、超过上限换文件只留两份、看最近 N 行、按文字和时间找；只给超级管理员', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-runlog-'));
  try {
    let now = Date.parse('2026-11-13T08:00:00Z');
    const file = join(dir, 'logs', 'run.log');
    const log = new RunLog(file, 400, () => now);
    log.append('启动完成\n企业微信 token=' + hex64 + '\n', 'out');
    now += 60_000;
    log.append('保存失败：password: Fictional-pass-1', 'err');
    assert.ok(!readFileSync(file, 'utf8').includes(hex64));
    assert.ok(!readFileSync(file, 'utf8').includes('Fictional-pass-1'));
    const last = readRunLog(log, boss, { lines: 2 });
    assert.deepEqual(last.lines.map((l) => [l.stream, l.text]), [
      ['输出', '企业微信 token=***'],
      ['错误', '保存失败：password: ***'],
    ]);
    assert.equal(searchRunLog(log, boss, { text: '保存失败' }).total, 1);
    assert.equal(searchRunLog(log, boss, { from: '2026-11-13T08:00:30Z' }).total, 1);
    assert.equal(searchRunLog(log, boss, { to: '2026-11-13T08:00:30Z' }).total, 2);
    for (let i = 0; i < 40; i++) log.append('第' + i + '行 填充内容填充内容', 'out');
    const kept = readRunLog(log, boss, { lines: 1000 });
    assert.ok(kept.total < 42, '旧的被滚掉了');
    assert.match(kept.lines[kept.lines.length - 1].text, /第39行/);
    assert.throws(() => readRunLog(log, clerk), (e: AppError) => e.status === 403);
    assert.throws(() => searchRunLog(log, null), (e: AppError) => e.status === 401);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('运行日志：抄下进程的输出，原来的输出照旧，撤销后不再抄', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-runlog-'));
  try {
    const log = new RunLog(join(dir, 'run.log'));
    const undo = captureProcessOutput(log);
    try {
      process.stdout.write('虚构的运行输出 secret=Fictional-1\n');
      process.stderr.write(Buffer.from('虚构的错误输出\n'));
    } finally {
      undo();
    }
    process.stdout.write('撤销以后的输出\n');
    assert.deepEqual(log.lines().map((l) => [l.stream, l.text]), [
      ['输出', '虚构的运行输出 secret=***'],
      ['错误', '虚构的错误输出'],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 临时拼一个程序目录：代码目录里放了机密文件、指出去的目录联接，旁边是数据目录和程序目录之外的机密 */
function fakeProgram() {
  const base = mkdtempSync(join(tmpdir(), 'erp-source-'));
  const root = join(base, 'app'),
    outside = join(base, 'outside');
  for (const d of ['server/accounts', 'server/core', 'server/data', 'shared', 'docs', 'node_modules/pkg', 'data', 'server/private', 'server/security']) mkdirSync(join(root, d), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, 'server/accounts/auth.ts'), Array.from({ length: 450 }, (_, i) => `// 第 ${i + 1} 行${i === 0 ? ' 虚构代码' : ''}`).join('\n'));
  writeFileSync(join(root, 'server/core/keys.ts'), `const apiKey = 'sk-abcdefghijklmnop1234'; // 虚构代码\nconst session = '${hex64}';\n`);
  writeFileSync(join(root, 'server/.env'), 'DEEPSEEK_KEY=虚构代码');
  writeFileSync(join(root, 'server/core/server.pem'), '虚构代码');
  writeFileSync(join(root, 'server/core/erp.sqlite'), '虚构代码');
  writeFileSync(join(root, 'server/data/x.ts'), '虚构代码');
  writeFileSync(join(root, 'server/private/x.ts'), '虚构代码');
  writeFileSync(join(root, 'server/security/x.ts'), '虚构代码');
  // 名字无害的联接指到不给读的目录里（等同于 Windows 短文件名 SECURI~1 的效果）：真实路径的每一段都要核对
  symlinkSync(join(root, 'server/security'), join(root, 'server/alias'), 'junction');
  writeFileSync(join(root, 'node_modules/pkg/index.js'), '虚构代码');
  writeFileSync(join(root, 'data/erp.ts'), '虚构代码');
  writeFileSync(join(root, 'docs/使用手册.md'), '# 虚构代码说明');
  writeFileSync(join(outside, 'secret.ts'), '虚构代码 在程序目录之外');
  // 目录联接（Windows 不用管理员权限）指到程序目录外面
  symlinkSync(outside, join(root, 'server/linked'), 'junction');
  const scope: SourceScope = { root, denied: [join(root, 'server/private')] };
  return { base, root, outside, scope };
}

test('读程序代码的范围：从程序目录读起，业务库所在的数据目录、备份目录、配置目录列为禁区', () => {
  const scope = programSource();
  assert.ok(existsSync(join(scope.root, 'server/system/paths.ts')), '程序目录应当是项目根目录');
  assert.deepEqual(scope.denied, [dirname(defaultDbPath), backupDirectory(), configDirectory()]);
});

test('读程序代码：各种越界写法、机密文件、数据和依赖目录、指出去的链接一律拒绝', () => {
  const { base, root, outside, scope } = fakeProgram();
  try {
    const refused = [
      '../outside/secret.ts',
      'server/../../outside/secret.ts',
      'server\\..\\..\\outside\\secret.ts',
      'server/./accounts/auth.ts',
      join(root, 'server/accounts/auth.ts'),
      '/etc/passwd',
      'C:/Windows/win.ini',
      'c:server/accounts/auth.ts',
      '\\\\host\\share\\x.ts',
      '~/x.ts',
      'server/accounts/auth.ts:stream',
      'data/erp.ts',
      'node_modules/pkg/index.js',
      'tests/x.ts',
      'server/.env',
      'server/core/server.pem',
      'server/core/erp.sqlite',
      'server/data/x.ts',
      'server/private/x.ts',
      'server/linked/secret.ts',
      'server/linked',
      'server/alias/x.ts',
      join(outside, 'secret.ts'),
      '',
      'server/accounts/auth.ts\0',
    ];
    for (const path of refused)
      assert.throws(() => resolveSourcePath(scope, path), (e: AppError) => e.status === 403 || e.status === 400, path);
    assert.throws(() => resolveSourcePath(scope, 'server/core/nothing.ts'), (e: AppError) => e.status === 404);
    assert.equal(resolveSourcePath(scope, 'server\\accounts\\auth.ts').path, 'server/accounts/auth.ts');
    assert.throws(() => readProgramSource(scope, boss, { file: 'server/linked/secret.ts' }), (e: AppError) => e.status === 403);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('读程序代码：按行读最多 200 行、搜索跳过机密文件和链接；只给超级管理员', () => {
  const { base, scope } = fakeProgram();
  try {
    const part = readProgramSource(scope, boss, { file: 'server/accounts/auth.ts', from: 100, to: 900 });
    assert.deepEqual([part.from, part.to, part.totalLines, part.lines.length], [100, 299, 450, 200]);
    assert.equal(part.lines[0].text, '// 第 100 行');
    assert.throws(() => readProgramSource(scope, boss, { file: 'server/accounts/auth.ts', from: 999 }), /只有 450 行/);
    assert.throws(() => readProgramSource(scope, boss, { file: 'server/core' }), /目录/);
    const found = searchProgramSource(scope, boss, { text: '虚构代码' });
    const files = [...new Set(found.matches.map((m) => m.file))].sort();
    assert.deepEqual(files, ['docs/使用手册.md', 'server/accounts/auth.ts', 'server/core/keys.ts']);
    assert.equal(found.truncated, false);
    assert.equal(searchProgramSource(scope, boss, { text: '// 第', limit: 5 }).truncated, true, '到上限就停');
    const keys = searchProgramSource(scope, boss, { text: 'apiKey', directory: 'server/core' });
    // 读代码用轻一档的打码：密钥本身遮掉，叫 key、token 的变量名和代码结构不动（不会变成残句）
    assert.equal(keys.matches[0].text, "const apiKey = '***'; // 虚构代码");
    assert.ok(!/\*\*\*/.test(searchProgramSource(scope, boss, { text: '第 100 行' }).matches[0].text));
    assert.throws(() => searchProgramSource(scope, boss, { text: 'x' }), /2 到 200/);
    assert.throws(() => searchProgramSource(scope, boss, { text: '虚构', directory: '../outside' }), (e: AppError) => e.status === 403);
    assert.throws(() => searchProgramSource(scope, clerk, { text: '虚构代码' }), (e: AppError) => e.status === 403);
    assert.throws(() => readProgramSource(scope, null, { file: 'server/accounts/auth.ts' }), (e: AppError) => e.status === 401);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/** 字段名像机密的、值像密钥令牌的都算漏 */
const secretName = /password|passwd|hash|salt|token|csrf|secret|key|cookie|session|credential/i;
const secretValue = [/[0-9a-f]{32,}/i, /\bsk-[A-Za-z0-9]{8,}/, /Fictional-(pass|secret)/];
function leaks(value: unknown, path = '结果'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => leaks(v, path + '[' + i + ']'));
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([k, v]) => [...(secretName.test(k) ? [path + '.' + k + '（字段名）'] : []), ...leaks(v, path + '.' + k)]);
  return typeof value === 'string' && secretValue.some((p) => p.test(value)) ? [path + '：' + value] : [];
}

test('每个读取函数交出去的结果里没有机密字段名，也没有像密钥、令牌、口令的值', () => {
  const { base, root, scope } = fakeProgram();
  const auth = new AuthManager(join(root, 'users.sqlite'));
  try {
    const problems = new ProblemLog();
    problems.record({
      source: 'server',
      account: '虚构管理员',
      method: 'POST',
      path: '/api/ai/settings?token=' + hex64,
      operation: '保存AI 设置',
      category: '出错',
      status: 500,
      message: '密钥 sk-abcdefghijklmnop1234 不对，password=Fictional-pass-1',
      reason: 'Error: csrf ' + hex64,
      stack: ['fn server/ai/settings.ts:12 ' + hex64],
      page: '#ai-settings?key=' + hex64,
    });
    auth.event(null, 'login-failed-unknown');
    const run = new RunLog(join(base, 'run.log'));
    run.append('Authorization: Bearer ' + hex64 + '\nsession=' + hex64 + '\npassword: Fictional-pass-1', 'err');
    const results = {
      最近出错: readRecentProblems(problems, boss),
      登录记录: readLoginRecords(auth.db, boss),
      最近运行日志: readRunLog(run, boss),
      查运行日志: searchRunLog(run, boss, { text: 'session' }),
      搜代码: searchProgramSource(scope, boss, { text: 'const' }),
      读代码: readProgramSource(scope, boss, { file: 'server/core/keys.ts' }),
    };
    for (const [name, result] of Object.entries(results)) {
      assert.ok(JSON.stringify(result).length > 20, name + '有内容');
      assert.deepEqual(leaks(result, name), [], name);
    }
    problems.close();
  } finally {
    auth.close();
    rmSync(base, { recursive: true, force: true });
  }
});
