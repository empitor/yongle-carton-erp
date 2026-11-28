// 三家共用挡板（.claude/hooks/）的兜底：认不出就不放行。
// ① 删除、搬走的目标认不出（变量不是同一条命令里赋的、命令替换、子表达式、cd 到认不出的目录后的相对路径）就拦；同一条命令里赋的、
//   临时目录来的照常。② Antigravity 参数名认不出的，看着像路径的字符串都当路径判。③ 回不了“先问”的（Codex、Antigravity）改成拦，
//   Codex 自己会问的前缀不出声；Claude Code 前缀清单认不出的变形写法由挡板问。④ 跑脚本文件时扫脚本内容（shell 全文、代码只看写死的）。
// 只喂字符串，或在系统临时目录里建虚构的目录和脚本、起钩子进程喂虚构输入，不碰真的东西。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempDisposableSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readToolCall } from '../../.claude/hooks/hook-input.mjs';
import { deliverable, judge } from '../../.claude/hooks/protect-real-data.mjs';

const root = 'C:\\Users\\虚构用户\\Desktop\\纸箱厂管理软件';
const repo = fileURLToPath(new URL('../..', import.meta.url));
const scratch = 'C:/Users/虚构用户/AppData/Local/Temp/claude/x/scratchpad';
const decision = (result) => result?.decision ?? 'allow';
const shellAt = (cwd, base = root) => (command) =>
  decision(judge(readToolCall({ tool_name: 'Bash', tool_input: { command }, cwd }, base), [base]));
const bash = shellAt(root);
const agy = (name, args) => decision(judge(readToolCall({ toolCall: { name, args }, cwd: repo }, repo), [repo]));
const decisions = (commands, run = bash) => commands.map((command) => [command, run(command)]);
const all = (commands, want) => commands.map((command) => [command, want]);

test('删除、搬走的目标认不出就拦，提示写字面路径或同一条命令里赋值', () => {
  const unknown = [
    'rm -rf $tmp',
    'Remove-Item -Recurse -Force $t',
    'rm -rf "$(git rev-parse --show-toplevel)/out"',
    'rm -rf `pwd`/out',
    'Remove-Item -Recurse (Get-Item $x)',
    'cd $X && rm -rf build',
    'mv $a /tmp/erp-x/b',
    'for f in $(ls); do rm "$f"; done',
    '$items | Remove-Item',
    'Get-ChildItem $t | Remove-Item -Recurse',
    'git rm -r $x',
    'find $d -delete',
  ];
  assert.deepEqual(decisions(unknown), all(unknown, 'deny'));
  assert.match(judge(readToolCall({ tool_name: 'Bash', tool_input: { command: 'rm -rf $tmp' }, cwd: root }, root), [root]).reason, /字面路径/);
});

test('同一条命令里赋的变量、临时目录来的、字面列表的循环照常删；变量指到 data 的照拦；覆盖类目标是变量的照旧放行', () => {
  const fine = [
    `S="${scratch}"; F="$S/f7"; O="$F/repo-old"; rm -rf "$O/.claude/hooks"`,
    'T="$(mktemp -d)"; echo x > "$T/a"; rm -rf "$T"',
    '$t = Join-Path $env:TEMP "erp-x"; Remove-Item -Recurse -Force $t',
    'rm -rf "$TMPDIR/erp-x"',
    'Remove-Item -Recurse $env:TEMP\\erp-x-1',
    'for f in a.log b.log; do rm "$f"; done',
    'Get-ChildItem C:\\Temp\\erp-x | ForEach-Object { Remove-Item $_ }',
    'Remove-Item -Recurse (Join-Path $env:TEMP "erp-x")',
    'echo x > $LOG',
    'git status | Out-File $log',
    'cp a.txt $dest',
  ];
  assert.deepEqual(decisions(fine), all(fine, 'allow'));
  const data = [`R="${root.replaceAll('\\', '/')}"; rm -rf "$R/data"`, `$r = '${root}'; Remove-Item -Recurse "$r\\backups"`];
  assert.deepEqual(decisions(data), all(data, 'deny'));
});

test('写进文件的 heredoc、here-string 正文里提到删变量的不算；不带引号的 heredoc 里会执行的 $( ) 照拦', () => {
  const notes = [
    "cat >> /tmp/erp-x/修-F7.md <<'EOF'\n- 写法：`rm -rf \"$O/x\"`、`Remove-Item -Recurse $t`\nEOF",
    "cat >> /tmp/erp-x/修-F7.md <<'EOF'\n同一条命令里赋值再删：\nrm -rf \"$O/x\"\nRemove-Item -Recurse $t\nEOF",
    "@'\nrm -rf $tmp\n'@ | Set-Content C:\\Temp\\erp-x\\a.md",
  ];
  assert.deepEqual(decisions(notes), all(notes, 'allow'));
  assert.equal(bash('cat > /tmp/erp-x/a.txt <<EOF\n$(rm -rf $tmp)\nEOF'), 'deny');
});

test('Antigravity 参数名认不出的，看着像路径的字符串都当路径判；带空白的文字、网址不算', () => {
  assert.equal(agy('some_new_tool', { Target: join(repo, 'data', 'x.sqlite') }), 'deny');
  assert.equal(agy('write_thing', { Dest: 'tests/fixtures/schema-v20.sql' }), 'deny');
  assert.equal(agy('note_tool', { Text: '这里只是提到 data/x 的一段话' }), 'allow');
  assert.equal(agy('open_link', { Link: 'http://127.0.0.1:3201/data/x' }), 'allow');
});

test('Antigravity 只写 data、backups 一个词的，参数名像路径才当路径（复审 R6-2）', () => {
  assert.equal(agy('grep_search', { SearchPath: join(repo, 'src'), Query: 'data' }), 'allow');
  assert.equal(agy('grep_search', { SearchPath: join(repo, 'src'), Query: 'backups' }), 'allow');
  assert.equal(agy('run_command', { CommandLine: 'git status', Note: 'data' }), 'allow');
  for (const args of [{ SomeDir: 'data' }, { TargetFolder: 'backups' }, { FileName: 'data' }, { X: 'data/erp.sqlite' }])
    assert.equal(agy('some_new_tool', args), 'deny', JSON.stringify(args));
});

test('引号里的 | 不算管道：搜 rm、rename 这类字的命令照常；真管道里前头列文件、后头删的照拦（复审 R6-1）', () => {
  const searches = [
    'grep -rnE "updateProduct|rename" server/',
    'git diff | grep -E "^-|rm|del"',
    'rg "move|rename" src',
    'Select-String -Path .claude\\hooks\\*.mjs -Pattern "Remove-Item|rm"',
    'echo "a|rm|b"',
    'node -e "console.log(\'x|del\')"',
    'git log --oneline --grep "mv|rename"',
    'npm test -- tests/checks/claude-hooks.test.mjs | grep -E "主套件|失败|rm|del"',
    'grep -rn "cd -|popd|rimraf|iex" tests/checks',
  ];
  assert.deepEqual(decisions(searches), all(searches, 'allow'));
  const pipes = ['Get-ChildItem | Remove-Item', 'ls | xargs rm -rf', 'git ls-files -d | xargs rm', '$items | Remove-Item', 'echo x | rm -rf $t'];
  assert.deepEqual(decisions(pipes), all(pipes, 'deny'));
});

test('回不了“先问”的：Codex、Antigravity 改成拦并说明；Codex 自己会问的不出声；Claude Code 照旧问', () => {
  const call = (command, antigravity = false) => ({ ...readToolCall({ tool_name: 'Bash', tool_input: { command }, cwd: repo }, repo), antigravity });
  const deliver = (command, { claude = false, antigravity = false } = {}) =>
    decision(deliverable(judge(call(command, antigravity), [repo]), call(command, antigravity), { claude, root: repo }));
  for (const command of ['curl http://127.0.0.1:3001/', 'git -C . push', 'FOO=1 git push', 'npx tsx server/stop.ts'])
    assert.equal(deliver(command), 'deny', command);
  assert.match(deliverable(judge(call('git -C . push'), [repo]), call('git -C . push'), { claude: false, root: repo }).reason, /Codex/);
  for (const command of ['git push origin main', 'npm stop']) assert.equal(deliver(command), 'allow', command);
  assert.equal(deliver('git push', { antigravity: true }), 'deny');
  for (const command of ['git -C . push', 'curl http://127.0.0.1:3001/', 'npm --save-dev install x'])
    assert.equal(deliver(command, { claude: true }), 'ask', command);
});

const toolCall = (tool, command) => readToolCall({ tool_name: tool, tool_input: { command }, cwd: repo }, repo);
/** 一条命令回给 Claude Code（claude 为真）或回不了先问的地方时是什么 */
const deliver = (tool, command, claude) =>
  decision(deliverable(judge(toolCall(tool, command), [repo]), toolCall(tool, command), { claude, root: repo }));
/** 每条在两种地方各回什么，和期望的 [命令, Claude Code, 别家] 比 */
const bothWays = (list) => list.map(([tool, command]) => [command, deliver(tool, command, true), deliver(tool, command, false)]);
const expected = (list, claude, other) => list.map(([, command]) => [command, claude, other]);

test('“先问”只在真的要连、要启停时回：搜索、打印、比较、测试参数里提到这些字样的，Claude Code 和别家都放行', () => {
  const mention = [
    ['Bash', 'git grep -n "127.0.0.1:3001" -- docs'],
    ['Bash', 'git grep -n "localhost:3001" -- docs AGENTS.md'],
    ['Bash', 'rg "127.0.0.1:3001" docs'],
    ['Bash', 'grep -rn "systemctl restart yongle-carton-erp" docs'],
    ['Bash', 'grep -rn "service yongle-carton-erp restart" docs'],
    ['PowerShell', 'Select-String -Path docs\\*.md -Pattern "127.0.0.1:3001"'],
    ['PowerShell', 'Get-Content docs\\运维\\排查.md | Select-String "localhost:3001"'],
    ['Bash', 'echo "curl http://127.0.0.1:3001/api/health"'],
    ['Bash', 'git grep -n "npm stop" -- docs'],
    ['Bash', 'grep -rn "node scripts/ui-check/real-smoke.mjs --yes" docs'],
    ['Bash', 'git grep -n "npx tsx server/stop.ts" -- docs'],
    ['Bash', 'git grep -n "git -C . push" -- docs'],
    ['Bash', 'git log --oneline -S "127.0.0.1:3001"'],
    ['Bash', 'npm test -- tests/checks/claude-hooks.test.mjs --test-name-pattern "127.0.0.1:3001"'],
    ['Bash', 'diff docs/a.md docs/b.md | grep 3001'],
  ];
  assert.deepEqual(bothWays(mention), expected(mention, 'allow', 'allow'));
  const connect = [
    ['Bash', 'curl -fsS http://127.0.0.1:3001/api/health'],
    ['PowerShell', 'Invoke-WebRequest -Uri http://127.0.0.1:3001/api/health'],
    ['PowerShell', '$r = Invoke-RestMethod http://127.0.0.1:3001/api/health'],
    ['Bash', 'node -e "fetch(\'http://127.0.0.1:3001/api/health\')"'],
    ['PowerShell', 'Start-Process http://localhost:3001'],
    ['Bash', 'ssh yongle-erp "sudo systemctl restart yongle-carton-erp"'],
    ['Bash', 'npm --silent stop'],
    ['PowerShell', 'node scripts\\ui-check\\real-smoke.mjs --yes'],
    ['Bash', 'npx tsx server/stop.ts'],
    ['Bash', 'git -C . push'],
  ];
  assert.deepEqual(bothWays(connect), expected(connect, 'ask', 'deny'));
});

test('只读、只打印的程序才算只是提到：名单外的程序（ssh、plink、wsl、.NET、认不出的）、变量拼的地址照问（复审 R6b-1）', () => {
  const unknownPrograms = [
    ['Bash', 'ssh yongle-erp "curl -fsS http://127.0.0.1:3001/api/health"'],
    ['Bash', 'ssh -L 13001:127.0.0.1:3001 operator@server.example'],
    ['Bash', 'BASE=http://127.0.0.1:3001; curl -fsS "$BASE/api/health"'],
    ['PowerShell', "$base = 'http://127.0.0.1:3001'; Invoke-RestMethod \"$base/api/health\""],
    ['PowerShell', "(New-Object Net.WebClient).DownloadString('http://127.0.0.1:3001/api/health')"],
    ['PowerShell', "[System.Net.Http.HttpClient]::new().GetStringAsync('http://127.0.0.1:3001/')"],
    ['Bash', 'npx wait-on http://127.0.0.1:3001'],
    ['Bash', 'wsl curl http://127.0.0.1:3001/'],
    ['Bash', 'certutil -urlcache -f http://127.0.0.1:3001/api/health out.json'],
    ['Bash', 'plink yongle-erp "sudo systemctl restart yongle-carton-erp"'],
  ];
  assert.deepEqual(bothWays(unknownPrograms), expected(unknownPrograms, 'ask', 'deny'));
  const written = "cat >> /tmp/erp-x/修-F7.md <<'EOF'\n- 请跑 `echo 127.0.0.1:3001` 核一次；服务器上 ssh yongle-erp \"curl http://127.0.0.1:3001\"\nEOF";
  assert.deepEqual([deliver('Bash', written, true), deliver('Bash', written, false)], ['allow', 'allow']);
});

test('只读程序借命令替换、管道后头的 xargs、git -c 去连的照问，平时的照旧放行（复审 R6c-1）', () => {
  const borrowed = [
    ['Bash', 'echo "$(curl -s http://127.0.0.1:3001/api/health)"'],
    ['Bash', 'echo `curl -s http://127.0.0.1:3001/api/health`'],
    ['PowerShell', 'Write-Output "$(Invoke-WebRequest http://127.0.0.1:3001/api/health)"'],
    ['Bash', 'echo http://127.0.0.1:3001/api/health | xargs curl -s'],
    ['Bash', "printf 'http://127.0.0.1:3001/' | xargs -I{} curl {}"],
    ['Bash', "git -c core.pager='curl -s http://127.0.0.1:3001/api/health' log -1"],
    ['Bash', "git -c diff.external='curl http://127.0.0.1:3001/' diff"],
  ];
  assert.deepEqual(bothWays(borrowed), expected(borrowed, 'ask', 'deny'));
  const stillFine = [
    ['Bash', 'echo "curl http://127.0.0.1:3001/"'],
    ['Bash', 'git log -S "127.0.0.1:3001"'],
    ['Bash', 'git -c core.quotepath=false log -S "127.0.0.1:3001"'],
    ['Bash', 'git log -S "127.0.0.1:3001" | head -20'],
    ['Bash', 'echo "命中: $(git grep -n "127.0.0.1:3001" -- docs | wc -l)"'],
    ['Bash', 'ERP_BASE=http://127.0.0.1:3001 npm test -- tests/checks/claude-hooks.test.mjs'],
    ['PowerShell', 'Write-Output "http://127.0.0.1:3001" | Set-Content C:\\Temp\\erp-x\\note.txt'],
  ];
  assert.deepEqual(bothWays(stillFine), expected(stillFine, 'allow', 'allow'));
});

test('写进会被执行的文件（脚本、$PROFILE、.git/hooks/）不算只读；单引号里、PowerShell 里的反引号只是文字（复审 R6d）', () => {
  const scripts = [
    ['PowerShell', "Set-Content x.ps1 'Invoke-RestMethod http://127.0.0.1:3001/api/health'; & .\\x.ps1"],
    ['PowerShell', "Add-Content $PROFILE 'iwr http://127.0.0.1:3001/api/health'"],
    ['PowerShell', "Set-Content .git/hooks/pre-commit 'curl http://127.0.0.1:3001/api/health'"],
    ['Bash', "echo 'curl http://127.0.0.1:3001/api/health' | tee x.sh && sh x.sh"],
  ];
  assert.deepEqual(bothWays(scripts), expected(scripts, 'ask', 'deny'));
  const text = [
    ['Bash', "echo '用 `curl http://127.0.0.1:3001/api/health` 查'"],
    ['PowerShell', 'Write-Host "地址：http://127.0.0.1:3001/api/health`n"'],
    ['PowerShell', 'Set-Content C:\\Temp\\erp-x\\note.md "地址 http://127.0.0.1:3001/"'],
  ];
  assert.deepEqual(bothWays(text), expected(text, 'allow', 'allow'));
});

test('作为钩子运行：有 CLAUDE_PROJECT_DIR 的回先问，没有的（Codex）回拦下', () => {
  const run = (env) => spawnSync(process.execPath, [join(repo, '.claude', 'hooks', 'protect-real-data.mjs')], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'curl http://127.0.0.1:3001/' }, cwd: repo }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: env },
  });
  assert.equal(JSON.parse(run(repo).stdout).hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(JSON.parse(run(undefined).stdout).hookSpecificOutput.permissionDecision, 'deny');
});

/** 系统临时目录里建一个虚构项目根目录和一个放脚本的目录 */
function scriptFixture(t) {
  const temp = mkdtempDisposableSync(join(tmpdir(), 'erp-hooks-scripts-'));
  t.after(() => temp.remove());
  const base = realpathSync.native(temp.path);
  const project = join(base, 'project');
  const scripts = join(base, 'scripts');
  mkdirSync(project);
  mkdirSync(scripts);
  const write = (name, text) => {
    writeFileSync(join(scripts, name), text);
    return join(scripts, name).replaceAll('\\', '/');
  };
  return { project, write, run: shellAt(project, project) };
}

test('跑脚本文件时扫内容：shell 脚本全文、代码脚本里写死的删写和命令', (t) => {
  const { write, run } = scriptFixture(t);
  const bad = [
    'sh "' + write('a.sh', 'set -e\nrm -rf data\n') + '"',
    'powershell -File "' + write('b.ps1', 'Remove-Item -Recurse backups\n') + '"',
    'node "' + write('c.mjs', "import { rmSync } from 'node:fs';\nrmSync('data', { recursive: true });\n") + '"',
    'node "' + write('d.mjs', "import { writeFileSync } from 'node:fs';\nwriteFileSync('tests/fixtures/schema-v20.sql', '');\n") + '"',
    'node --import tsx "' + write('e.mts', "import { execSync } from 'node:child_process';\nexecSync('rm -rf backups');\n") + '"',
    'python "' + write('f.py', "import shutil\nshutil.rmtree('data')\n") + '"',
  ];
  assert.deepEqual(decisions(bad, run), all(bad, 'deny'));
  const scriptsDir = write('g.mjs', "import { rmSync } from 'node:fs';\nrmSync('data');\n").replace(/\/g\.mjs$/, '');
  assert.equal(run(`S="${scriptsDir}"; node "$S/g.mjs"`), 'deny');
});

test('跑脚本文件时：字符串里提到的、拼出来的路径、删临时目录的、照抄 snapshot.sh 的照常', (t) => {
  const { write, run } = scriptFixture(t);
  const fine = [
    'node "' + write('a.mjs', "const command = \"node -e \\\"require('fs').rmSync('data')\\\"\";\nconsole.log(command);\n") + '"',
    'node "' + write('b.mjs', "import { rmSync } from 'node:fs';\nimport { join } from 'node:path';\nrmSync(join(process.env.TMP_X, 'data'), { recursive: true });\n") + '"',
    'sh "' + write('c.sh', 'rm -rf /tmp/erp-x\n') + '"',
    'sh "' + write('snapshot.sh', '#!/bin/sh\ncd "C:/Temp/erp-x" || exit 1\nT="$(mktemp)"\ncp .git/index "$T"\nGIT_INDEX_FILE="$T" git add -A 2>/dev/null\nGIT_INDEX_FILE="$T" git write-tree\nrm -f "$T"\n') + '"',
    'node "' + write('d.mjs', '// rmSync(\'data\') 写在注释里\nconsole.log(1);\n') + '"',
  ];
  assert.deepEqual(decisions(fine, run), all(fine, 'allow'));
});

test('跑脚本文件时：项目里 git 跟踪着、没改过的脚本不扫，改过的照扫', (t) => {
  const temp = mkdtempDisposableSync(join(tmpdir(), 'erp-hooks-git-'));
  t.after(() => temp.remove());
  const project = realpathSync.native(temp.path);
  const git = (...args) => execFileSync('git', ['-C', project, '-c', 'user.name=虚构', '-c', 'user.email=fake@example.invalid', ...args], { stdio: 'ignore' });
  mkdirSync(join(project, 'scripts'));
  writeFileSync(join(project, 'scripts', 'clean.sh'), 'rm -rf data\n');
  git('init', '-q');
  git('add', 'scripts/clean.sh');
  git('commit', '-q', '-m', '虚构');
  const run = shellAt(project, project);
  assert.equal(run('sh scripts/clean.sh'), 'allow');
  writeFileSync(join(project, 'scripts', 'clean.sh'), 'rm -rf data\nrm -rf backups\n');
  assert.equal(run('sh scripts/clean.sh'), 'deny');
});
