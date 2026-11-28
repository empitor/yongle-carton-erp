// 三家共用挡板里由 AGENTS.md 规矩变来的几条：启动正式服务、真实数据维护、直接跑测试、登记豁免、
// 本机受保护目录、定下不许改的文件（拦）；连正式实例、停正式实例、连真实模型、改检查的配置（先问）。
// 后半是补上的漏拦写法（8.3 短名、浏览器批量和脚本、命令行写入、裸写目录名等）和平时要用的命令照旧放行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempDisposableSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readToolCall } from '../../.claude/hooks/hook-input.mjs';
import { judge } from '../../.claude/hooks/protect-real-data.mjs';

const root = 'C:\\Users\\虚构用户\\Desktop\\纸箱厂管理软件';
const repo = fileURLToPath(new URL('../..', import.meta.url));
const localApp = 'C:\\Users\\虚构用户\\AppData\\Local\\';
const verdict = (input, base = root) => judge(readToolCall(input, base), [base]);
const claude = (tool_name, tool_input, cwd = root) => verdict({ tool_name, tool_input, cwd }, cwd === root ? root : repo);
const bash = (command, cwd = root) => claude('Bash', { command }, cwd);
const agy = (name, args) => verdict({ toolCall: { name, args }, cwd: repo }, repo);
const decision = (result) => result?.decision ?? 'allow';
/** 四个目录都指到临时目录（AGENTS.md“常用命令”） */
const sandbox = 'LOCALAPPDATA=/tmp/erp-x ERP_CONFIG_DIR=/tmp/erp-x/cfg DB_PATH=/tmp/erp-x/x.sqlite ERP_BACKUP_DIR=/tmp/erp-x/bak';
const decisions = (commands, run = bash) => commands.map((command) => [command, decision(run(command))]);
const all = (commands, want) => commands.map((command) => [command, want]);

test('启动正式服务和真实数据维护的命令都拦', () => {
  for (const command of [
    'npm start',
    'npm restart',
    'npm run dev',
    'npm.cmd run start',
    'npx tsx server/index.ts',
    'node --import tsx server/index.ts',
    'node -e "import(\'./server/index.ts\')"',
    'node scripts/start-system.mjs',
    'node scripts/dev-system.mjs',
    'npm run backup',
    'npm run reset-password -- admin',
    'npx tsx server/maintenance.ts restore',
  ])
    assert.equal(decision(bash(command)), 'deny', command);
  assert.match(bash('npm run dev').reason, /正式服务/);
  assert.match(bash('npm run restore').reason, /真实数据/);
});

test('只是提到正式服务入口的命令和加载 server/app.ts 的不拦', () => {
  for (const command of [
    'git diff -- server/index.ts',
    'cat server/index.ts',
    'npx eslint server/index.ts --quiet',
    'npx tsc --noEmit',
    'node -e "import(\'./server/app.ts\')"',
    'npm run test:ui -- production',
    'node scripts/ui-check/preview.mjs',
  ])
    assert.equal(decision(bash(command)), 'allow', command);
});

test('不经 npm test 直接跑 --test、又没把四个目录都指到临时目录的拦', () => {
  for (const command of [
    'node --test tests/checks/a.test.mjs',
    'npx tsx --test tests/core/a.test.ts',
    '$env:LOCALAPPDATA = "C:\\Temp\\erp-x"; npx tsx --test tests/core/a.test.ts',
    'LOCALAPPDATA=/tmp/x ERP_CONFIG_DIR=/tmp/x DB_PATH=/tmp/x.sqlite node --test tests/a.test.mjs',
  ]) {
    const result = bash(command);
    assert.equal(decision(result), 'deny', command);
    assert.match(result.reason, /npm test --/);
  }
});

test('npm test、四个目录都指到临时目录的、外壳自己的测试照常跑', () => {
  for (const command of [
    'npm test -- tests/checks/a.test.mjs',
    'node scripts/run-tests.mjs --release tests/release/a.test.ts',
    sandbox + ' npx tsx --test tests/core/a.test.ts',
    '$env:LOCALAPPDATA = "C:\\Temp\\x"; $env:ERP_CONFIG_DIR = "C:\\Temp\\x\\c"; $env:DB_PATH = "C:\\Temp\\x\\a.sqlite"; $env:ERP_BACKUP_DIR = "C:\\Temp\\x\\b"; npx tsx --test tests/core/a.test.ts',
    'cd apps/desktop && node --test --test-concurrency=1 tests/shell.e2e.test.mjs',
  ])
    assert.equal(decision(bash(command)), 'allow', command);
  const desktop = root + '\\apps\\desktop';
  assert.equal(decision(verdict({ tool_name: 'Bash', tool_input: { command: 'node --test tests/a.test.mjs' }, cwd: desktop })), 'allow');
});

test('往代码检查里登记豁免的命令拦，普通代码检查不拦', () => {
  assert.equal(decision(bash('npx eslint src --suppress-all')), 'deny');
  assert.equal(decision(bash('npm run lint -- --suppress-rule complexity')), 'deny');
  assert.equal(decision(bash('npx eslint src --quiet')), 'allow');
});

test('本机的真实模型密钥目录和桌面测试版目录：文件工具和命令里的路径都拦', () => {
  for (const [tool, file_path] of [
    ['Read', localApp + 'erp-real-model-test\\config\\ai.sqlite'],
    ['Write', localApp + '甬勒ERP测试\\config\\app.json'],
  ])
    assert.equal(decision(claude(tool, { file_path })), 'deny', file_path);
  for (const command of ['dir "%LOCALAPPDATA%\\erp-real-model-test"', 'Get-ChildItem $env:LOCALAPPDATA\\甬勒ERP测试'])
    assert.equal(decision(bash(command)), 'deny', command);
  assert.equal(decision(bash('grep -rn erp-real-model-test scripts/')), 'allow');
});

test('定下不许改的文件：三家写入都拦，读照常', () => {
  const v20 = join(repo, 'tests', 'fixtures', 'schema-v20.sql');
  const baseline = join(repo, 'tests', 'fixtures', 'config-db', 'accounts-v1.sql');
  assert.equal(decision(claude('Write', { file_path: v20 }, repo)), 'deny');
  assert.equal(decision(claude('Edit', { file_path: baseline }, repo)), 'deny');
  assert.equal(decision(claude('Edit', { file_path: join(repo, 'eslint-suppressions.json') }, repo)), 'deny');
  const patch = '*** Begin Patch\n*** Update File: tests/fixtures/schema-v20.sql\n@@\n-a\n+b\n*** End Patch';
  assert.equal(decision(verdict({ tool_name: 'apply_patch', tool_input: { command: patch }, cwd: repo }, repo)), 'deny');
  assert.equal(decision(agy('write_file', { Path: baseline })), 'deny');
  assert.equal(decision(claude('Read', { file_path: v20 }, repo)), 'allow');
  assert.equal(decision(agy('read_file', { Path: baseline })), 'allow');
});

test('新加配置库的基线快照可以写', () => {
  const fresh = join(repo, 'tests', 'fixtures', 'config-db', '虚构配置库-v1.sql');
  assert.equal(decision(claude('Write', { file_path: fresh }, repo)), 'allow');
});

test('改检查的配置先问人，读不问', () => {
  const result = claude('Edit', { file_path: join(repo, 'eslint.config.js') }, repo);
  assert.equal(decision(result), 'ask');
  assert.match(result.reason, /eslint\.config\.js/);
  assert.equal(decision(agy('edit_file', { Path: join(repo, 'knip.json') })), 'ask');
  assert.equal(decision(claude('Read', { file_path: join(repo, 'eslint.config.js') }, repo)), 'allow');
  assert.equal(decision(claude('Edit', { file_path: join(repo, 'scripts', 'test-exemptions.mjs') }, repo)), 'allow');
});

test('连正式实例的命令和浏览器地址先问人，测试实例的端口不问', () => {
  assert.equal(decision(bash('curl -fsS http://127.0.0.1:3001/api/health')), 'ask');
  assert.equal(decision(claude('mcp__Claude_Browser__navigate', { url: 'http://localhost:3001/orders' })), 'ask');
  assert.equal(decision(agy('open_browser_url', { Url: 'http://127.0.0.1:3001' })), 'ask');
  for (const command of ['curl http://127.0.0.1:3201/', 'curl http://127.0.0.1:30010/'])
    assert.equal(decision(bash(command)), 'allow', command);
  assert.equal(decision(bash('curl http://127.0.0.1:3001/ && cat .env')), 'deny');
});

test('启停服务器上的正式服务先问人，看状态不问', () => {
  assert.equal(decision(bash('ssh yongle-erp "sudo systemctl restart yongle-carton-erp"')), 'ask');
  assert.equal(decision(bash('ssh yongle-erp "systemctl status yongle-carton-erp"')), 'allow');
});

/** 挡板要接上的 Claude 工具：文件、命令、网址，内置浏览器（含远程设备）和 Chrome 扩展的打开网址、批量动作、执行脚本 */
const HOOKED_TOOLS = [
  'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'Bash', 'PowerShell', 'WebFetch',
  ...['mcp__Claude_Browser__', 'mcp__remote-devices__Claude_Browser__'].flatMap((prefix) =>
    ['navigate', 'preview_start', 'browser_batch', 'javascript_tool'].map((name) => prefix + name)),
  ...['navigate', 'browser_batch', 'javascript_tool'].map((name) => 'mcp__claude-in-chrome__' + name),
];

test('Claude 的前置钩子接在挡板会读的每种工具上', () => {
  const settings = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'));
  const matcher = new RegExp('^(?:' + settings.hooks.PreToolUse[0].matcher + ')$');
  assert.deepEqual(HOOKED_TOOLS.filter((tool) => !matcher.test(tool)), []);
});

test('浏览器的批量动作、执行脚本、远程设备的浏览器连正式实例也先问', () => {
  const batch = (url) => ({ actions: [{ name: 'computer', input: { action: 'screenshot' } }, { name: 'navigate', input: { url } }] });
  const script = { action: 'javascript_exec', text: "await fetch('http://127.0.0.1:3001/api/x')" };
  for (const [tool, input] of [
    ['mcp__Claude_Browser__browser_batch', batch('http://127.0.0.1:3001/')],
    ['mcp__claude-in-chrome__browser_batch', batch('localhost:3001/orders')],
    ['mcp__Claude_Browser__javascript_tool', script],
    ['mcp__claude-in-chrome__javascript_tool', script],
    ['mcp__remote-devices__Claude_Browser__navigate', { url: 'http://127.0.0.1:3001/' }],
  ])
    assert.equal(decision(claude(tool, input)), 'ask', tool);
  assert.equal(decision(claude('mcp__Claude_Browser__browser_batch', batch('http://127.0.0.1:3201/'))), 'allow');
});

/** 在系统临时目录建一个长名目录，取它的 8.3 短名；这台机器没开短名就返回空串 */
function shortName(long) {
  const out = execFileSync('cmd', ['/d', '/c', 'for %I in ("' + long + '") do @echo %~sI'], {
    encoding: 'utf8',
    windowsVerbatimArguments: true,
  }).trim();
  return out && out.toLowerCase() !== long.toLowerCase() ? out : '';
}

test('Windows 的 8.3 短名写法和长名写法一样拦（两个方向都查）', { skip: process.platform !== 'win32' }, (t) => {
  const temp = mkdtempDisposableSync(join(tmpdir(), 'erp-hooks-'));
  t.after(() => temp.remove());
  const long = join(realpathSync.native(temp.path), 'shortname-project-root');
  mkdirSync(join(long, 'tests', 'fixtures'), { recursive: true });
  writeFileSync(join(long, 'tests', 'fixtures', 'schema-v20.sql'), '');
  writeFileSync(join(long, 'eslint.config.js'), '');
  const short = shortName(long);
  if (!short) return t.skip('这台机器的临时目录没有 8.3 短名');
  const run = (base, tool_name, tool_input) => decision(judge(readToolCall({ tool_name, tool_input, cwd: base }, base), [base]));
  for (const [base, path] of [[long, short], [short, long]]) {
    assert.equal(run(base, 'Read', { file_path: path + '\\data\\erp.sqlite' }), 'deny', path);
    assert.equal(run(base, 'Bash', { command: 'cat "' + path.replaceAll('\\', '/') + '/backups/a.json"' }), 'deny', path);
    assert.equal(run(base, 'Write', { file_path: path + '\\tests\\fixtures\\schema-v20.sql' }), 'deny', path);
    assert.equal(run(base, 'Edit', { file_path: path + '\\eslint.config.js' }), 'ask', path);
  }
  assert.equal(run(long, 'Read', { file_path: short + '\\src\\a.ts' }), 'allow');
});

test('启动、停止正式实例的双击脚本和带选项的 npm 也认得出', () => {
  const starts = [
    'cmd /c 启动系统.cmd',
    '& .\\启动系统.cmd',
    'Start-Process .\\启动系统.cmd',
    'npm --silent start',
    'npm -s run dev',
    'npm --loglevel=error run backup',
  ];
  assert.deepEqual(decisions(starts), all(starts, 'deny'));
  const stops = ['cmd /c 停止系统.cmd', 'npx tsx server/stop.ts', 'node --import tsx server\\stop.ts', 'npm --silent stop'];
  assert.deepEqual(decisions(stops), all(stops, 'ask'));
  const reads = ['cat 启动系统.cmd', 'git diff -- 启动系统.cmd 停止系统.cmd scripts/start-system.mjs server/stop.ts', 'npm run dev:ui'];
  assert.deepEqual(decisions(reads), all(reads, 'allow'));
});

test('命令行写定下不许改的文件拦、写检查的配置先问，读和导出到别处不拦', () => {
  const locked = [
    'echo x > tests/fixtures/schema-v20.sql',
    "Set-Content eslint-suppressions.json '{}'",
    'cp /tmp/x.sql tests/fixtures/schema-v20.sql',
    'rm tests/fixtures/schema-v20.sql',
    'node -e "require(\'fs\').writeFileSync(\'eslint-suppressions.json\', \'{}\')"',
  ];
  assert.deepEqual(decisions(locked), all(locked, 'deny'));
  const baseline = 'Move-Item tests/fixtures/config-db/accounts-v1.sql x.sql';
  assert.equal(decision(bash(baseline, repo)), 'deny');
  const configs = ["'{}' | Out-File knip.json", "sed -i 's/error/off/' eslint.config.js", 'echo {} >> .jscpd.json'];
  assert.deepEqual(decisions(configs), all(configs, 'ask'));
  const reads = [
    'cat tests/fixtures/schema-v20.sql',
    'git diff eslint.config.js > /tmp/x.diff 2>&1',
    'cp tests/fixtures/schema-v20.sql /tmp/x.sql',
    'npx eslint -c eslint.config.js src',
    "sed -n '1,20p' eslint.config.js",
  ];
  assert.deepEqual(decisions(reads), all(reads, 'allow'));
});

test('Antigravity 的 run_command 也查 Cwd', () => {
  assert.equal(decision(agy('run_command', { CommandLine: 'type erp.sqlite', Cwd: join(repo, 'data') })), 'deny');
  assert.equal(decision(agy('run_command', { CommandLine: 'dir', Cwd: join(repo, 'src') })), 'allow');
});

test('连真实模型的脚本不论斜杠怎么写都先问，连假模型、只列场景的不问', () => {
  const real = [
    'node scripts\\ui-check\\real-smoke.mjs --yes',
    'node .\\scripts\\ui-check\\real-smoke.mjs --yes --only chat',
    'node ./scripts/ui-check/real-suite.mjs --start --yes',
    'node scripts/ui-check/real-recognition.mjs --start --port 3196 --label 改后 --yes',
  ];
  assert.deepEqual(decisions(real), all(real, 'ask'));
  assert.deepEqual(decisions(real, (CommandLine) => agy('run_command', { CommandLine })), all(real, 'ask'));
  // 正斜杠的完整写法在审批清单里（Claude Code 本来就问），这里用清单外的写法看挡板自己的规则不问
  const fake = ['node .\\scripts\\ui-check\\real-suite.mjs --list', 'node scripts\\ui-check\\real-smoke.mjs --port 3201'];
  assert.deepEqual(decisions(fake), all(fake, 'allow'));
});

test('裸写 data、backups 目录名的删除、复制、搬走、列目录命令拦，别处的同名目录和只是提到这个词的不拦', () => {
  const touches = [
    'rm -rf data',
    'cp -r data /tmp/x',
    'mv backups old',
    'Remove-Item -Recurse data',
    'Copy-Item data D:\\x -Recurse',
    'tar czf x.tgz backups',
    'ls data',
    'node -e "require(\'fs\').rmSync(\'data\',{recursive:true})"',
    'Remove-Item -Path:backups -Recurse',
  ];
  assert.deepEqual(decisions(touches), all(touches, 'deny'));
  const others = [
    'grep -rn data src',
    'rm -rf src/data',
    'git log --grep data',
    'echo "rm -rf data"',
    'robocopy src C:\\Temp\\erp-copy /E /XD data backups node_modules',
    'tar czf /tmp/x.tgz --exclude=data --exclude backups src',
    'Copy-Item src\\* C:\\Temp\\x -Recurse -Exclude data',
  ];
  assert.deepEqual(decisions(others), all(others, 'allow'));
  const inSrc = verdict({ tool_name: 'Bash', tool_input: { command: 'rm -rf data' }, cwd: root + '\\src' });
  assert.equal(decision(inSrc), 'allow');
});

/** 在别的当前目录下跑的命令（项目根目录还是虚构的 root） */
const bashAt = (cwd) => (command) => verdict({ tool_name: 'Bash', tool_input: { command }, cwd }, root);

test('连带整个 data、backups 的删除和复制拦：git clean -x、git stash -a、根目录和通配、find -delete', () => {
  const sweeps = [
    'git clean -fdx',
    'git clean -fdX',
    'git clean -f -d -x',
    'git -C . clean -X -f',
    'git stash -a',
    'git stash --all',
    'git stash push -a -m 临时',
    'rm -rf *',
    'rm -rf ./*',
    'rm -rf da*',
    'rm -rf {data,tmp}',
    'Remove-Item * -Recurse -Force',
    'rm -rf .',
    'cp -r . /tmp/copy',
    'robocopy . C:\\Temp\\erp-copy /E /XD data backups',
    'Copy-Item * C:\\Temp\\x -Recurse -Exclude data',
    'tar czf /tmp/all.tgz .',
    'find data -delete',
    'find . -name "*.tmp" -delete',
    'find . -name x -exec rm {} +',
  ];
  assert.deepEqual(decisions(sweeps), all(sweeps, 'deny'));
  assert.match(bash('git clean -fdx').reason, /git clean -fd/);
  const fromSrc = ['rm -rf ..', 'git clean -fdx ..', 'git clean -fdx :/', 'git stash -a'];
  assert.deepEqual(decisions(fromSrc, bashAt(root + '\\src')), all(fromSrc, 'deny'));
  assert.equal(decision(bashAt(root + '\\src')('git clean -fdx')), 'allow');
  const fine = [
    'git status',
    'git diff',
    'git stash',
    'git stash list',
    'git stash pop',
    'git clean -fd',
    'git clean -n -x',
    'git clean -ndX',
    'rm -rf src/*',
    'rm -rf *.log',
    'cp C:\\Temp\\a.txt .',
    'mv /tmp/x.txt .',
    'Copy-Item C:\\Temp\\a.txt -Destination .',
    'find . -name "*.ts"',
    'ls *',
    'du -sh *',
    'rm -rf /tmp/erp-x/data',
  ];
  assert.deepEqual(decisions(fine), all(fine, 'allow'));
  const elsewhere = ['git clean -fdx', 'rm -rf *', 'find . -delete'];
  assert.deepEqual(decisions(elsewhere, bashAt('C:\\Temp\\erp-x')), all(elsewhere, 'allow'));
});

test('PowerShell 的 [IO.File]、python 的 open(…, "w")、dd 写定下不许改的文件也拦，只读的不拦', () => {
  const writes = [
    "[IO.File]::WriteAllText('tests/fixtures/schema-v20.sql', '')",
    'python -c "open(\'tests/fixtures/schema-v20.sql\', \'w\')"',
    'python -c "from pathlib import Path; Path(\'eslint-suppressions.json\').write_text(\'{}\')"',
    'dd if=/dev/zero of=tests/fixtures/schema-v20.sql',
  ];
  assert.deepEqual(decisions(writes), all(writes, 'deny'));
  assert.equal(decision(bash("[IO.File]::AppendAllText('knip.json', 'x')")), 'ask');
  const reads = [
    "[IO.File]::ReadAllText('tests/fixtures/schema-v20.sql')",
    'python -c "print(open(\'tests/fixtures/schema-v20.sql\').read())"',
  ];
  assert.deepEqual(decisions(reads), all(reads, 'allow'));
});

test('写进草稿文件的 heredoc、here-string 正文不当命令；直接执行的正文和写到锁定文件的照拦', () => {
  const body = "fs.writeFileSync('knip.json', x)\nrm tests/fixtures/schema-v20.sql";
  const data = [
    "cat > /tmp/erp-x/a.mjs <<'EOF'\n" + body + '\nEOF',
    "@'\n" + body + "\n'@ | Set-Content C:\\Temp\\a.mjs",
  ];
  assert.deepEqual(decisions(data), all(data, 'allow'));
  const run = [
    "cat > tests/fixtures/schema-v20.sql <<'EOF'\nx\nEOF",
    "node <<'EOF'\nrequire('fs').writeFileSync('eslint-suppressions.json', '{}')\nEOF",
  ];
  assert.deepEqual(decisions(run), all(run, 'deny'));
});

test('不带引号的 heredoc、@"…"@ 里的 $( ) 和反引号会执行，里面的写入照拦；带引号的正文不当命令', () => {
  const doc = (inner) => 'cat > /tmp/erp-x/a.txt <<EOF\n' + inner + '\nEOF';
  const runs = [
    [doc('$(rm tests/fixtures/schema-v20.sql)'), 'deny'],
    [doc('$(echo x > tests/fixtures/schema-v20.sql)'), 'deny'],
    [doc("$(sed -i 's/a/b/' eslint.config.js)"), 'ask'],
    [doc('`rm tests/fixtures/schema-v20.sql`'), 'deny'],
    ['$s = @"\n$(Remove-Item tests/fixtures/schema-v20.sql)\n"@', 'deny'],
  ];
  assert.deepEqual(runs.map(([command]) => [command, decision(bash(command))]), runs);
  const quoted = [
    "cat > /tmp/erp-x/a.sh <<'EOF'\n$(rm tests/fixtures/schema-v20.sql)\nEOF",
    'cat > /tmp/erp-x/a.sh <<"EOF"\n`rm tests/fixtures/schema-v20.sql`\nEOF',
    "$s = @'\n$(Remove-Item tests/fixtures/schema-v20.sql)\n'@",
    doc('普通文字，提到 tests/fixtures/schema-v20.sql 和 eslint.config.js'),
  ];
  assert.deepEqual(decisions(quoted), all(quoted, 'allow'));
});

test('交给 iex、[scriptblock]::Create 执行的 here-string 里的写入照拦', () => {
  const runs = [
    "@'\nRemove-Item tests/fixtures/schema-v20.sql\n'@ | iex",
    "& ([scriptblock]::Create(@'\nRemove-Item tests/fixtures/schema-v20.sql\n'@))",
  ];
  assert.deepEqual(decisions(runs), all(runs, 'deny'));
});

test('经 npx、npm exec 跑的删除（rimraf、shx rm）也拦', () => {
  const runs = [
    'npx rimraf data',
    'npx shx rm -rf data',
    'npx rimraf tests/fixtures/schema-v20.sql',
    'npm exec -- rimraf backups',
    'npx --yes rimraf *',
  ];
  assert.deepEqual(decisions(runs), all(runs, 'deny'));
  const fine = ['npx rimraf /tmp/erp-x/out', 'npx tsc --noEmit', 'npx eslint tests/checks', 'npx shx ls src'];
  assert.deepEqual(decisions(fine), all(fine, 'allow'));
});

test('先进脚本目录再跑连真实模型的脚本也先问', () => {
  const real = ['cd scripts/ui-check; node real-smoke.mjs --yes', 'cd scripts\\ui-check && node .\\real-suite.mjs --start --yes'];
  assert.deepEqual(decisions(real), all(real, 'ask'));
  assert.equal(decision(bash('cd scripts/ui-check; node real-suite.mjs --list')), 'allow');
});

test('平时要用的命令和草稿目录里的读写照旧放行', () => {
  const scratch = 'C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\claude\\c42e\\28c9\\scratchpad';
  const unix = scratch.replaceAll('\\', '/');
  const commands = [
    'npm test -- tests/checks/claude-hooks.test.mjs',
    'npm run check',
    'npx tsc --noEmit',
    'git status',
    'git diff',
    'git diff HEAD~1 -- .claude/hooks',
    'git show 71a579e~1:.claude/hooks/protect-real-data.mjs',
    sandbox + ' node --import tsx ' + unix + '/probe.mts',
    `$env:LOCALAPPDATA="${scratch}\\t"; $env:ERP_CONFIG_DIR="${scratch}\\t\\c"; $env:DB_PATH="${scratch}\\t\\a.sqlite"; $env:ERP_BACKUP_DIR="${scratch}\\t\\b"; node --import tsx ${scratch}\\probe.mts`,
    'sh ' + unix + '/snapshot.sh',
    'npm run docs:gen',
    'npm run test:ui',
    'npm run test:ui -- production',
    'node scripts/ui-check/preview.mjs --port 3201',
    'node scripts/ui-check/preview.mjs --remote',
    'curl http://127.0.0.1:3201/api/health',
    'ls ' + unix,
    'cat ' + unix + '/修-F7.md',
  ];
  assert.deepEqual(decisions(commands), all(commands, 'allow'));
  for (const [tool, file_path] of [['Read', scratch + '\\a.md'], ['Write', scratch + '\\f7\\b.mjs'], ['Edit', unix + '/c.md']])
    assert.equal(decision(claude(tool, { file_path })), 'allow', tool);
});
