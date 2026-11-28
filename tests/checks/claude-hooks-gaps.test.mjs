// 三家共用挡板（.claude/hooks/）补上的漏拦和改掉的多拦：管道删除、$PWD/~ 这类变量、多层 $( )、npx -p、\\?\ 前缀、Glob 列
// data 里的文件名、正式实例地址的别的写法、带选项的 systemctl、Antigravity 的 TargetFile/SearchDirectory（拦或先问）；
// 子目录下 git clean -x、tar -C、node -e 只读锁定文件、先 cd 再列目录、-Filter data、Join-Path 拼在临时目录下、浏览器里找字（放行），
// 每条多拦改掉的旁边都留着该拦的写法照拦。只喂字符串或在系统临时目录里建虚构目录，不碰真的东西。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempDisposableSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readToolCall } from '../../.claude/hooks/hook-input.mjs';
import { judge } from '../../.claude/hooks/protect-real-data.mjs';

const root = 'C:\\Users\\虚构用户\\Desktop\\纸箱厂管理软件';
const repo = fileURLToPath(new URL('../..', import.meta.url));
const decision = (result) => result?.decision ?? 'allow';
const verdict = (input, base = root) => decision(judge(readToolCall(input, base), [base]));
/** 在 cwd 下跑的命令行（根目录是 base） */
const shellAt = (cwd, base = root) => (command) => verdict({ tool_name: 'Bash', tool_input: { command }, cwd }, base);
const bash = shellAt(root);
const tool = (tool_name, tool_input, cwd = root) => verdict({ tool_name, tool_input, cwd });
const agy = (name, args) => verdict({ toolCall: { name, args }, cwd: repo }, repo);
const decisions = (commands, run = bash) => commands.map((command) => [command, run(command)]);
const all = (commands, want) => commands.map((command) => [command, want]);

test('管道里先列文件再删的，列的起点盖住 data、backups 就拦', () => {
  const sweeps = [
    'Get-ChildItem | Remove-Item -Recurse -Force',
    'Get-ChildItem -Recurse -Filter *.tmp | Remove-Item',
    'gci -Recurse | ForEach-Object { Remove-Item $_ }',
    'ls | xargs rm -rf',
    'find . -name "*.log" | xargs -n 1 rm',
  ];
  assert.deepEqual(decisions(sweeps), all(sweeps, 'deny'));
  const fine = ['Get-ChildItem src | Remove-Item', 'Get-ChildItem C:\\Temp\\erp-x | Remove-Item -Recurse', 'ls | grep x'];
  assert.deepEqual(decisions(fine), all(fine, 'allow'));
});

test('$PWD、$(pwd)、~、$HOME、$env:USERPROFILE 拼的路径按真实路径判', () => {
  const sweeps = ['rm -rf $PWD', 'rm -rf $(pwd)', 'rm -rf $PWD/data', 'Remove-Item -Recurse ${PWD}'];
  assert.deepEqual(decisions(sweeps), all(sweeps, 'deny'));
  const home = join(homedir(), 'Desktop', '虚构项目根');
  const homes = ['rm -rf ~', 'rm -rf $HOME/Desktop', 'Remove-Item -Recurse $env:USERPROFILE'];
  assert.deepEqual(decisions(homes, shellAt(home, home)), all(homes, 'deny'));
  assert.equal(shellAt(home, home)('rm -rf ~/erp-x-tmp'), 'allow');
});

test('三层以上的 $( )、npx -p 包名、npx -c 里的命令照拦', () => {
  const runs = [
    'cat > /tmp/erp-x/a.txt <<EOF\n$(echo $(echo $(rm tests/fixtures/schema-v20.sql)))\nEOF',
    'npx -p rimraf rimraf data',
    'npx -c "rimraf backups"',
  ];
  assert.deepEqual(decisions(runs), all(runs, 'deny'));
});

test('\\\\?\\ 前缀的路径和普通写法一样拦', () => {
  assert.equal(tool('Read', { file_path: '\\\\?\\' + root + '\\data\\erp.sqlite' }), 'deny');
  assert.equal(bash('cat "\\\\?\\' + root + '\\backups\\a.json"'), 'deny');
  assert.equal(tool('Read', { file_path: '\\\\?\\' + root + '\\src\\a.ts' }), 'allow');
});

test('Glob 的通配写法列得出 data、backups 里的文件名就拦，别处和只写 * 的照常', () => {
  const glob = (pattern, path) => tool('Glob', path ? { pattern, path } : { pattern });
  for (const [pattern, path] of [['**/data/*.sqlite'], ['**/backups/**', root], ['d*/*.json'], ['**/data/*', 'C:\\Users\\虚构用户']])
    assert.equal(glob(pattern, path), 'deny', pattern);
  for (const [pattern, path] of [['**/*.ts'], ['src/**/data/*.ts'], ['*/package.json'], ['**/data/*', root + '\\src']])
    assert.equal(glob(pattern, path), 'allow', pattern);
});

test('正式实例地址的别的写法、带选项的 systemctl、service 写法都先问，看状态和别的端口不问', () => {
  const asks = [
    'curl http://127.1:3001/',
    'curl http://0:3001/',
    'curl http://127.0.0.2:3001/',
    'curl "http://[::ffff:127.0.0.1]:3001/"',
    'curl "http://[0:0:0:0:0:0:0:1]:3001/"',
    'ssh h "sudo systemctl --no-block restart yongle-carton-erp"',
    'ssh h "sudo service yongle-carton-erp restart"',
    'ssh h "sudo systemctl mask yongle-carton-erp"',
    'ssh h "sudo systemctl restart nginx yongle-carton-erp"',
  ];
  assert.deepEqual(decisions(asks), all(asks, 'ask'));
  const fine = [
    'curl http://127.0.0.1:3201/',
    'echo 10:3001',
    'ssh h "systemctl --no-pager status yongle-carton-erp"',
    'ssh h "journalctl -u yongle-carton-erp -n 50"',
    'ssh h "sudo systemctl restart nginx"',
  ];
  assert.deepEqual(decisions(fine), all(fine, 'allow'));
});

test('Antigravity 的 TargetFile、SearchDirectory 也查路径', () => {
  assert.equal(agy('write_to_file', { TargetFile: join(repo, 'tests', 'fixtures', 'schema-v20.sql') }), 'deny');
  assert.equal(agy('find_by_name', { SearchDirectory: join(repo, 'data') }), 'deny');
  assert.equal(agy('write_to_file', { TargetFile: join(repo, 'src', 'a.ts') }), 'allow');
});

test('多拦改掉：子目录下 git clean -x、tar -C 根目录下的子目录、-Filter data、浏览器里找字', () => {
  const src = shellAt(root + '\\src');
  assert.equal(src('git clean -fdx'), 'allow');
  assert.equal(src('git clean -fdx ..'), 'deny');
  assert.equal(bash('tar czf /tmp/x.tgz -C ' + root + ' src'), 'allow');
  for (const command of ['tar czf /tmp/x.tgz -C ' + root + ' .', 'tar -c -f /tmp/x.tgz .', 'tar czf /tmp/x.tgz --directory=. .'])
    assert.equal(bash(command), 'deny', command);
  assert.equal(bash('Get-ChildItem -Recurse -Filter data src'), 'allow');
  assert.equal(bash('Get-ChildItem -Path data -Filter *.json'), 'deny');
  const find = { actions: [{ name: 'find', input: { query: 'localhost:3001' } }] };
  assert.equal(tool('mcp__Claude_Browser__browser_batch', find), 'allow');
  const go = { actions: [{ name: 'navigate', input: { url: 'http://localhost:3001/' } }] };
  assert.equal(tool('mcp__Claude_Browser__browser_batch', go), 'ask');
});

test('多拦改掉：node -e 只读锁定文件、写到别处的放行；写它的、经变量写的照拦', () => {
  const v20 = 'tests/fixtures/schema-v20.sql';
  assert.equal(bash(`node -e "fs.writeFileSync('/tmp/a.sql', fs.readFileSync('${v20}'))"`), 'allow');
  const writes = [
    `node -e "fs.writeFileSync('${v20}', fs.readFileSync('${v20}') + 'x')"`,
    `node -e "const p = '${v20}'; fs.writeFileSync(p, '')"`,
    `node -e "fs.writeFileSync(process.argv[1], fs.readFileSync('${v20}'))" ${v20}`,
  ];
  assert.deepEqual(decisions(writes), all(writes, 'deny'));
});

test('多拦改掉：同一条命令里 cd 进子目录后裸写的 data 按子目录算；cd 失败也会跑到的照拦', () => {
  assert.equal(bash('cd src && ls data'), 'allow');
  assert.equal(bash('cd src && rm -rf data'), 'allow');
  const still = ['cd src && cd .. && rm -rf data', 'cd src || rm -rf data', 'cd 没有的目录; rm -rf data', 'cd src | ls data', 'cd src && cat data/x'];
  assert.deepEqual(decisions(still), all(still, 'deny'));
});

test('多拦改掉：cd 到真存在的子目录后用 ; 接着的也按子目录算', (t) => {
  const temp = mkdtempDisposableSync(join(tmpdir(), 'erp-hooks-cd-'));
  t.after(() => temp.remove());
  const base = realpathSync.native(temp.path);
  mkdirSync(join(base, 'src'));
  assert.equal(shellAt(base, base)('cd src; ls data'), 'allow');
  assert.equal(shellAt(base, base)('cd 没有的目录; ls data'), 'deny');
  assert.equal(shellAt(base, base)('pushd src; popd; rm -rf data'), 'deny');
});

test('cd 回到原处（cd -、popd、Pop-Location）或目标是没展开的变量时，后面的按原目录算', () => {
  const back = [
    'cd - && rm -rf data',
    'cd src && cd - && rm -rf data',
    'pushd src && popd && rm -rf data',
    'Push-Location src && Pop-Location && Remove-Item -Recurse data',
    'cd $OLDPWD && rm -rf data',
    'cd "$CLAUDE_PROJECT_DIR" && rm -rf data',
    'cd $P && rm -rf data',
    'cd %CD% && rd /s /q data',
    'Set-Location -Path $root && rm -rf data',
  ];
  assert.deepEqual(decisions(back), all(back, 'deny'));
  const fine = ['cd src && ls data', 'pushd src && rm -rf data', 'cd ~/erp-x && rm -rf data', 'cd $PWD/src && ls data'];
  assert.deepEqual(decisions(fine), all(fine, 'allow'));
});

test('多拦改掉：Join-Path 拼在临时目录下的 data\\… 放行；父目录认不出的、在项目里的照拦', () => {
  const temps = [
    '$t = Join-Path $env:TEMP "erp-x"; $env:DB_PATH = Join-Path $t "data\\erp.sqlite"',
    'Join-Path $env:TEMP "data\\x"',
    'Join-Path ([IO.Path]::GetTempPath()) "data\\x"',
    'Join-Path "C:\\Temp\\erp-x" "data\\x"',
  ];
  assert.deepEqual(decisions(temps), all(temps, 'allow'));
  const unsure = ['Join-Path $t "data\\erp.sqlite"', 'Join-Path . "data\\x"', '$t = "."; Join-Path $t "data\\x"', 'Join-Path "' + root + '" "data\\x"'];
  assert.deepEqual(decisions(unsure), all(unsure, 'deny'));
  const reassigned = [
    '$t = Join-Path $env:TEMP "erp-x"; $t = "."; Join-Path $t "data\\erp.sqlite"',
    '$t = $env:TEMP; Set-Variable t .; Join-Path $t "data\\x"',
    '$t = $env:TEMP; $t += "\\..\\.."; Join-Path $t "data\\x"',
  ];
  assert.deepEqual(decisions(reassigned), all(reassigned, 'deny'));
});

test('Join-Path 拼出项目根目录下的 data、backups 再拿去删的照拦，拼到别处的不拦', () => {
  const removes = [
    "Remove-Item -Recurse (Join-Path '" + root + "' 'data')",
    'Remove-Item -Recurse -Force (Join-Path -Path "' + root + '" -ChildPath backups)',
    "$r = '" + root + "'; Remove-Item -Recurse (Join-Path $r 'data')",
    'Remove-Item -Recurse (Join-Path . data)',
  ];
  assert.deepEqual(decisions(removes), all(removes, 'deny'));
  const fine = ["Remove-Item -Recurse (Join-Path $env:TEMP 'data')", "Remove-Item -Recurse (Join-Path '" + root + "' 'src')"];
  assert.deepEqual(decisions(fine), all(fine, 'allow'));
});
