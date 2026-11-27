// 三家共用的保护钩子（.claude/hooks/）：保留原有的拦截范围，验证各工具的输入和进程输出；Antigravity 按共用清单请求确认；
// 文件变长提醒经 Claude Code 和 Codex 的 PostToolUse 输出；Claude Code 的 permissions.ask 和 Codex 的 ask-before.rules 两份命令审批清单逐项一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempDisposableSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readToolCall } from '../../.claude/hooks/hook-input.mjs';
import { judge } from '../../.claude/hooks/protect-real-data.mjs';
import { readAskRules } from '../../.claude/hooks/rules.mjs';

const root = 'C:\\Users\\虚构用户\\Desktop\\纸箱厂管理软件';
const repo = fileURLToPath(new URL('../..', import.meta.url));
const hookScript = (base, name) => join(base, '.claude', 'hooks', name + '.mjs');
const protectScript = hookScript(repo, 'protect-real-data');
const claudeCall = (tool_name, tool_input, cwd = root) => ({ tool_name, tool_input, cwd });
const agyCall = (name, args, cwd = root) => ({ hookEventName: 'PreToolUse', toolCall: { name, args }, cwd });
const codexCall = (tool, command, cwd = root) => ({
  ...claudeCall(tool, { command }, cwd),
  hook_event_name: 'PreToolUse',
  turn_id: 'test-turn',
});
const run = (tool, args) => judge(readToolCall(claudeCall(tool, args), root), [root])?.reason ?? '';
const bash = (command) => run('Bash', { command });
const patch = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');
function output(input, { script = protectScript, cwd, projectDir } = {}) {
  const result = spawnSync(process.execPath, [script], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    cwd,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout;
}
const agyDecision = (input, options) => JSON.parse(output(input, options) || '{}').decision;
function assertDenied(stdout, reason) {
  const out = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, reason);
}

test('文件类工具：真实数据目录、本机数据目录、密钥和 .env 都拦', () => {
  assert.match(run('Read', { file_path: root + '\\data\\erp.sqlite' }), /data\//);
  assert.match(run('Edit', { file_path: root + '\\backups\\2026-11-09\\x.json' }), /backups\//);
  assert.match(run('Write', { file_path: 'C:\\Users\\虚构用户\\AppData\\Local\\ZhixuERP\\config.json' }), /ZhixuERP/);
  assert.match(run('Read', { file_path: 'C:\\Users\\虚构用户\\.ssh\\empitor.pem' }), /密钥/);
  assert.match(run('Read', { file_path: root + '\\.env' }), /\.env/);
  assert.match(run('Read', { file_path: root + '\\.env.production' }), /\.env/);
  assert.match(run('Grep', { pattern: 'x', path: root + '\\data' }), /data\//);
  assert.match(run('Glob', { pattern: 'data/**/*.sqlite', path: root }), /data\//);
  assert.match(run('Glob', { pattern: 'backups/*' }), /backups\//);
});

test('文件类工具：同名但不在项目根目录下的、示例配置、普通源码都放行', () => {
  for (const file_path of [
    root + '\\src\\data\\x.ts',
    root + '\\tests\\fixtures\\backups\\a.json',
    root + '\\.env.example',
    root + '\\server\\backup.ts',
    root + '\\src\\vite-env.d.ts',
    'C:\\Users\\虚构用户\\AppData\\Local\\Temp\\erp-test\\ZhixuERP-copy\\a.json',
  ])
    assert.equal(run('Read', { file_path }), '', file_path);
  assert.equal(run('Glob', { pattern: '**/*.ts', path: root }), '');
  assert.equal(run('Grep', { pattern: 'ZhixuERP', path: root + '\\server' }), '');
});

test('命令行：读写真实数据、打印密钥、覆盖 dist 的构建都拦', () => {
  for (const command of [
    'cat data/erp.sqlite',
    'ls ./data/',
    'cd backups && ls',
    'sqlite3 "C:\\Users\\虚构用户\\Desktop\\纸箱厂管理软件\\data\\erp.sqlite" .tables',
    'ls /c/Users/虚构用户/Desktop/纸箱厂管理软件/backups',
    'Get-Content .\\data\\settings.json',
    'Get-ChildItem $env:LOCALAPPDATA\\ZhixuERP',
    'ls "$LOCALAPPDATA/ZhixuERP"',
    'type %LOCALAPPDATA%\\ZhixuERP\\a.json',
    'cat ~/.ssh/empitor.pem',
    'cp empitor.pem /tmp/',
    'cat .env',
    'npm run build',
    'npm.cmd run build',
    'node scripts/build.mjs',
    'npx vite build',
  ])
    assert.notEqual(bash(command), '', command);
  assert.notEqual(run('PowerShell', { command: 'npm run build' }), '');
});

test('命令行：正常开发命令不误拦', () => {
  for (const command of [
    'npm test',
    'npx tsc --noEmit',
    'npx vite build --outDir C:/Temp/erp-build --emptyOutDir',
    'npm run test:ui',
    'git status',
    'git diff -- server/overview/database-maintenance.ts',
    'grep -rn ZhixuERP server/',
    'ls src/data/ tests/fixtures/',
    'node -e "console.log(process.env.LOCALAPPDATA)"',
    'cat .env.example',
    'ssh -i ~/.ssh/empitor.pem yongle-erp uptime',
    'LOCALAPPDATA=/tmp/erp-x ERP_CONFIG_DIR=/tmp/erp-x/c DB_PATH=/tmp/erp-x/a.sqlite ERP_BACKUP_DIR=/tmp/erp-x/b npx tsx --test tests/delete-rules.test.ts',
    'node scripts/ui-check/preview.mjs --remote',
  ])
    assert.equal(bash(command), '', command);
});

test('作为钩子运行：拦下时输出 deny，放行时不输出；输入坏了也放行', () => {
  assertDenied(output(claudeCall('Bash', { command: 'cat data/x' })), /data\//);
  assert.equal(output(claudeCall('Bash', { command: 'npm test' })), '');
  assert.equal(output('不是 JSON'), '');
});
test('Codex 按 Bash 的命令拦截，正常命令和坏输入都放行', () => {
  assertDenied(output(codexCall('Bash', 'npm run build')), /dist/);
  assert.equal(output(codexCall('Bash', 'npm test')), '');
  assert.equal(output(codexCall('Bash', 'git push origin main')), '');
  assert.equal(output({ tool_name: 'Bash', tool_input: { command: [] } }), '');
  assert.equal(output('不是 JSON'), '');
});
test('Codex 逐个检查补丁的新增、修改、删除和移动目的路径', () => {
  const protectedPaths = [
    { lines: ['*** Add File: .env.local', '+example'], reason: /\.env/ },
    { lines: ['*** Update File: data/样例.txt', '@@', '-before', '+after'], reason: /data\// },
    { lines: ['*** Delete File: backups/样例.txt'], reason: /backups\// },
    { lines: ['*** Update File: safe.txt', '*** Move to: private.pem'], reason: /密钥/ },
  ];
  for (const { lines, reason } of protectedPaths) {
    const command = patch('*** Add File: test.md', '+example', ...lines);
    assertDenied(output(codexCall('apply_patch', command, repo)), reason);
  }
});
test('Codex 补丁内容提到受保护的路径时，普通源码照常修改', () => {
  const command = patch('*** Add File: src/notes.ts', '+*** Move to: data/a.txt', '+.env');
  assert.equal(output(codexCall('apply_patch', command, repo)), '');
});

test('Antigravity 的配置命令从 .agents 目录经 sh 启动后能拒绝受保护路径', () => {
  const cwd = join(repo, '.agents');
  const config = JSON.parse(readFileSync(join(cwd, 'hooks.json'), 'utf8'));
  const { command } = config['protect-real-data'].PreToolUse[0].hooks[0];
  const sh = process.platform === 'win32'
    ? join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../../bin/sh.exe') : 'sh';
  const input = JSON.stringify(agyCall('run_command', { CommandLine: 'Write-Output data/fake.txt' }));
  const result = spawnSync(sh, ['-c', command], { cwd, input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(JSON.parse(result.stdout).decision, 'deny');
});
test('Antigravity 按工具分别检查 CommandLine 和 Path，使用驼峰协议回话', () => {
  const deniedCommand = JSON.parse(output(agyCall('run_command', { CommandLine: 'type .env' })));
  assert.equal(deniedCommand.decision, 'deny');
  assert.match(deniedCommand.reason, /\.env/);
  for (const name of ['read_file', 'write_file', 'edit_file']) {
    const result = JSON.parse(output(agyCall(name, { Path: 'data/a.txt' }, repo)));
    assert.equal(result.decision, 'deny');
    assert.match(result.reason, /data\//);
  }
});
for (const [name, args] of [
  ['other_tool', { path: 'data/example.txt' }],
  ['run_workflow', { ScriptPath: 'data/example.py', Script: 'print("example")' }],
  ['run_workflow', { Cwd: 'backups' }],
  ['run_workflow', { Script: 'open("data/example.txt")' }],
]) {
  test('Antigravity 检查 ' + name + ' 的 ' + Object.keys(args)[0], () => {
    assert.equal(agyDecision(agyCall(name, args, repo)), 'deny');
  });
}
test('Antigravity 普通工具、无关参数和坏输入照常放行', () => {
  assert.equal(output(agyCall('run_command', { CommandLine: 'git status', Path: 'data/a.txt' }, repo)), '');
  assert.equal(output(agyCall('read_file', { Path: 'src/data/a.ts', File: 'data/a.txt' }, repo)), '');
  assert.equal(output({ toolCall: { args: { Path: 'data/a.txt' } } }), '');
  assert.equal(output('不是 JSON'), '');
});
function hookFixture(t, name) {
  const temp = mkdtempDisposableSync(join(tmpdir(), 'erp-hooks-'));
  t.after(() => temp.remove());
  const checkout = join(temp.path, name);
  cpSync(join(repo, '.claude', 'hooks'), join(checkout, '.claude', 'hooks'), { recursive: true });
  return { temp: temp.path, checkout };
}
test('cwd 为空时三家前置钩子都按项目根目录检查相对路径', (t) => {
  const { checkout, temp } = hookFixture(t, '项目根');
  const options = { script: hookScript(checkout, 'protect-real-data'), cwd: temp };
  assertDenied(output(claudeCall('Read', { file_path: 'data/fake.txt' }, ''), options), /data\//);
  const command = patch('*** Add File: data/fake.txt', '+example');
  assertDenied(output(codexCall('apply_patch', command, ''), options), /data\//);
  assert.equal(agyDecision(agyCall('read_file', { Path: 'data/fake.txt' }, ''), options), 'deny');
});
test('通过目录联接或符号链接启动前置钩子时仍然执行检查', (t) => {
  const { checkout, temp } = hookFixture(t, '项目根');
  const link = join(temp, '链接');
  symlinkSync(checkout, link, process.platform === 'win32' ? 'junction' : 'dir');
  const options = { script: hookScript(link, 'protect-real-data') };
  for (const cwd of [checkout, link])
    assertDenied(output(claudeCall('Read', { file_path: 'data/fake.txt' }, cwd), options), /data\//);
});
test('工作区的钩子由脚本位置找到自己和主项目，与启动目录和环境变量无关', (t) => {
  const { temp, checkout } = hookFixture(t, '工作区');
  const main = join(temp, '主项目');
  const gitDir = join(main, '.git', 'worktrees', 'test');
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, 'commondir'), '../..\n');
  writeFileSync(join(checkout, '.git'), 'gitdir: ' + relative(checkout, gitDir) + '\n');
  const options = { script: hookScript(checkout, 'protect-real-data'), cwd: temp, projectDir: temp };
  assertDenied(output(claudeCall('Read', { file_path: join(main, 'data', 'fake.txt') }, checkout), options), /data\//);
  const command = patch('*** Delete File: ' + join(main, 'backups', 'fake.txt'));
  assertDenied(output(codexCall('apply_patch', command, checkout), options), /backups\//);
  assert.equal(agyDecision(agyCall('read_file', { Path: 'data/fake.txt' }, checkout), options), 'deny');
  for (const CommandLine of [
    'cat "../主项目/data/fake.txt"',
    'sqlite3 --db=../主项目/data/fake.txt',
    'sqlite3 --db="../主项目/data/fake.txt"',
  ]) assert.equal(agyDecision(agyCall('run_command', { CommandLine }, checkout), options), 'deny');
});
function reminderFixture(t) {
  const { checkout, temp } = hookFixture(t, '测试副本');
  mkdirSync(join(checkout, 'src'));
  writeFileSync(join(checkout, 'src', '长文件.ts'), Array(301).fill('// example').join('\n'));
  return { checkout, options: { script: hookScript(checkout, 'file-size-reminder'), cwd: temp } };
}
function assertReminder(input, options) {
  const result = JSON.parse(output(input, options)).hookSpecificOutput;
  assert.equal(result.hookEventName, 'PostToolUse');
  assert.match(result.additionalContext, /src\/长文件\.ts 现在 301 行/);
}
test('文件变长提醒通过 Claude 和 Codex 的 PostToolUse 输出，缩短文件时保持静默', (t) => {
  const { checkout, options } = reminderFixture(t);
  const command = patch(
    '*** Update File: src/尚未保存.ts', '@@', '+missing',
    '*** Update File: src/旧文件.ts', '*** Move to: src/长文件.ts', '@@', '+example',
  );
  assertReminder(claudeCall('Write', { file_path: 'src/长文件.ts' }, checkout), options);
  assertReminder(codexCall('apply_patch', command, checkout), options);
  const shrank = patch('*** Update File: src/长文件.ts', '@@', '-one', '-two', '+one');
  assert.equal(output(codexCall('apply_patch', shrank, checkout), options), '');
});
test('文件变长提醒在 cwd 为空时以项目根目录为准', (t) => {
  const { options } = reminderFixture(t);
  assertReminder(claudeCall('Write', { file_path: 'src/长文件.ts' }, ''), options);
});
test('Windows 上用 Git Bash 盘符路径写长文件后仍有提醒', { skip: process.platform !== 'win32' }, (t) => {
  const { checkout, options } = reminderFixture(t);
  const file_path = join(checkout, 'src', '长文件.ts').replaceAll('\\', '/').replace(/^([a-z]):/i, '/$1');
  assertReminder(claudeCall('Write', { file_path }, checkout), options);
});
test('Claude 原生审批与 Codex 的所有命令规则都和共用清单逐项一致', () => {
  const claude = readAskRules(repo);
  const folder = join(repo, '.codex', 'rules');
  const lines = readdirSync(folder).filter((file) => file.endsWith('.rules'))
    .flatMap((file) => readFileSync(join(folder, file), 'utf8').split(/\r?\n/));
  const rules = lines.map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  const codex = rules.map((rule) => {
    const match = /^prefix_rule\(pattern = (.+), decision = "prompt", justification = "[^"]+"\)$/.exec(rule);
    assert.ok(match, '审批规则应为单条命令前缀和 prompt 决定：' + rule);
    const [programs, ...args] = JSON.parse(match[1]);
    assert.ok(Array.isArray(programs), '命令名应列出无后缀、.cmd 和 .exe 三种写法');
    return JSON.stringify([programs.sort(), ...args]);
  });
  for (const tool of ['Bash', 'PowerShell']) {
    const expected = claude.filter((rule) => rule.tool === tool).map(({ prefix: [program, ...args] }) =>
      JSON.stringify([[program, program + '.cmd', program + '.exe'], ...args]));
    assert.deepEqual(codex.sort(), expected.sort(), tool);
  }
});
test('Antigravity 按脚本所在项目的 settings.json 决定哪些命令要确认', (t) => {
  const { checkout } = hookFixture(t, '改过审批清单的项目');
  const ask = ['Bash(demo confirm *)', 'WebFetch(*)', 'PowerShell(Remove-Item *)'];
  writeFileSync(join(checkout, '.claude', 'settings.json'), JSON.stringify({ permissions: { ask } }));
  const options = { script: hookScript(checkout, 'protect-real-data') };
  const approved = JSON.parse(output(agyCall('run_command', { CommandLine: 'demo confirm' }), options));
  assert.equal(approved.decision, 'ask');
  assert.match(approved.reason, /demo confirm/);
  assert.equal(agyDecision(agyCall('run_command', { CommandLine: 'remove-item example' }), options), 'ask');
  assert.equal(output(agyCall('run_command', { CommandLine: 'git push' }), options), '');
});
for (const { prefix } of readAskRules(repo).filter((rule) => rule.tool === 'Bash')) {
  const command = prefix.join(' ');
  test('Antigravity 对 ' + command + ' 请求确认', () => {
    const result = JSON.parse(output(agyCall('run_command', { CommandLine: 'echo ready && ' + command })));
    assert.equal(result.decision, 'ask');
    assert.ok(result.reason.includes(command));
  });
}
for (const CommandLine of [
  'FOO=1 git push',
  '(git push)',
  'if ($true) { git push }',
  '& "C:\\Program Files\\Git\\bin\\git.exe" push',
  'git -C . push',
  'git -c core.x=y --no-pager push origin main',
  'powershell -NoProfile -c "git push"',
  'npm --save-dev install x',
]) {
  test('Antigravity 要求确认包装过的命令 ' + CommandLine, () => {
    assert.equal(agyDecision(agyCall('run_command', { CommandLine })), 'ask');
  });
}
test('Antigravity 放行类似的普通命令，明确要拦的命令优先返回 deny', () => {
  for (const CommandLine of ['git tagger', 'npm run package-notes', 'echo "text; git push"']) {
    assert.equal(output(agyCall('run_command', { CommandLine })), '');
  }
  const denied = JSON.parse(output(agyCall('run_command', { CommandLine: 'git push && cat .env' })));
  assert.equal(denied.decision, 'deny');
});
