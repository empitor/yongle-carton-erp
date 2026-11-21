// Claude Code 保护钩子（.claude/hooks/protect-real-data.mjs）：该拦的拦，正常开发命令不误拦。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verdict } from '../.claude/hooks/protect-real-data.mjs';

const root = 'C:\\Users\\虚构用户\\Desktop\\纸箱厂管理软件';
const run = (tool_name, tool_input) => verdict({ tool_name, tool_input, cwd: root }, root);
const bash = (command) => run('Bash', { command });

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
    'git diff -- server/business/database-maintenance.ts',
    'grep -rn ZhixuERP server/',
    'ls src/data/ tests/fixtures/',
    'node -e "console.log(process.env.LOCALAPPDATA)"',
    'cat .env.example',
    'ssh -i ~/.ssh/empitor.pem yongle-erp uptime',
    'LOCALAPPDATA=/tmp/erp-x npx tsx --test tests/delete-rules.test.ts',
    'node scripts/ui-check/preview.mjs --remote',
  ])
    assert.equal(bash(command), '', command);
});

test('作为钩子运行：拦下时输出 deny，放行时不输出；输入坏了也放行', () => {
  const hook = fileURLToPath(new URL('../.claude/hooks/protect-real-data.mjs', import.meta.url));
  const call = (input) =>
    spawnSync(process.execPath, [hook], {
      input,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
  const denied = call(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'cat data/x' }, cwd: root }));
  assert.equal(denied.status, 0);
  const out = JSON.parse(denied.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /data\//);
  const allowed = call(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: root }));
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout, '');
  const broken = call('不是 JSON');
  assert.equal(broken.status, 0);
  assert.equal(broken.stdout, '');
});
