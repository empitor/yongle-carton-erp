// 挡板规则（三家共用，判断只写在这里）：把 AGENTS.md 里几条“绝对不能做”和“用户说了才能做”变成机器挡板。
// 拦：读写 data/、backups/、%LOCALAPPDATA%\ZhixuERP（真实业务数据），密钥文件（.pem）和 .env，
// 以及会覆盖正式实例 dist 的构建（npm run build、不带 --outDir 的 vite build）。只拦明确命中的路径和命令。
import { readFileSync } from 'node:fs';
import { join, resolve, win32 } from 'node:path';

const DATA_RULE = '（AGENTS.md“绝对不能做”）。测试用 :memory: 或临时目录配虚构数据；确实要动真实数据请用户自己操作。';
const DATA_DIRS = ['data', 'backups'];

/** 读 Claude 的 Bash、PowerShell 命令前缀，Antigravity 共用这份审批清单。 */
export function readAskRules(root) {
  const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
  return settings.permissions.ask.flatMap((rule) => {
    const match = /^(Bash|PowerShell)\(([^()*]+) \*\)$/.exec(rule);
    if (!match) return [];
    return [{ tool: match[1], prefix: match[2].toLowerCase().split(/\s+/) }];
  });
}

/** 统一成小写、正斜杠；Git Bash 的 /c/Users 转成 c:/Users。 */
const norm = (text) =>
  String(text)
    .replaceAll('\\', '/')
    .replace(/(^|[\s"'=(])\/([a-z])\//gi, '$1$2:/')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();

/** 项目根目录统一成 norm 的样子、去掉末尾斜杠，好和路径、命令文字比对 */
export const normRoot = (root) => norm(root).replace(/\/$/, '');

const WINDOWS_PATH = /^[a-z]:[\\/]/i;
const fromBashDrive = (path) => path.replace(/^\/([a-z])\//i, '$1:/');
/** 拼绝对路径：带盘符的按 Windows 的规矩拼，在哪种系统上跑结果都一样（Linux 上不这样拼会把 C:\… 当成相对路径，该拦的拦不住） */
export function absolute(base, path) {
  const target = fromBashDrive(path);
  const cwd = fromBashDrive(base);
  const resolver = WINDOWS_PATH.test(target) || WINDOWS_PATH.test(cwd) ? win32.resolve : resolve;
  return resolver(cwd, target);
}

function protectedDataDir(abs, roots) {
  for (const root of roots)
    for (const dir of DATA_DIRS)
      if (abs === root + '/' + dir || abs.startsWith(root + '/' + dir + '/'))
        return dir;
  return '';
}

const dataReason = (dir) => '不能读写真实业务数据目录 ' + dir + '/' + DATA_RULE;

/** 文件类工具给的路径：解析成绝对路径后比对。 */
export function checkPath(raw, roots, cwd) {
  if (!raw || typeof raw !== 'string') return '';
  const abs = normRoot(absolute(cwd, raw));
  const dir = protectedDataDir(abs, roots);
  if (dir) return dataReason(dir);
  if (/\/appdata\/local\/zhixuerp(\/|$)/.test(abs))
    return '不能读写 %LOCALAPPDATA%\\ZhixuERP 里的真实数据' + DATA_RULE;
  if (/\.pem$/.test(abs)) return '不能读取或改动密钥文件（.pem），密钥不进聊天和日志。';
  if (/\/\.env(\.[a-z0-9_-]+)?$/.test(abs) && !abs.endsWith('/.env.example'))
    return '不能读取或改动 .env，里面是密钥和本机配置，不进聊天和日志；参考字段看 .env.example。';
  return '';
}

// 引号里的分隔符是参数文字。括号和花括号可包住一整段命令。
const shellTokens = (text) => text.match(/(?:"[^"]*"|'[^']*'|[^\s"';&|<>(){}])+|[;&|\r\n(){}]/g) ?? [];
const unquote = (word) => word.replace(/^(["'])(.*)\1$/, '$2');

/** 命令文字里碰到真实数据目录：相对路径、进目录、项目根目录（各个）的绝对路径 */
function dataDirIn(text, roots, cwd) {
  // 相对路径：data/…、./data/…、backups\…；前面必须是命令行分隔，src/data/ 这类不算。
  const relative = /(?:^|[\s"'=(;|&<>,])(?:\.\/)?(data|backups)\//.exec(text);
  // 进入目录：cd data、Set-Location backups
  const enter = /(?:^|[\s;&|(])(?:cd|pushd|set-location|sl)\s+["']?(?:\.\/)?(data|backups)["']?(?=$|[\s;&|)])/.exec(text);
  const hit = relative || enter;
  if (hit) return hit[1];
  for (const root of roots) {
    const inRoot = new RegExp(
      root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/(data|backups)(?=$|[/\\s"\';|&)])',
    ).exec(text);
    if (inRoot) return inRoot[1];
  }
  // 工作区可以用 ../主项目/data/… 访问真实目录，也按路径解析。
  for (const token of shellTokens(text)) {
    const argument = unquote(token);
    const path = unquote(argument.replace(/^[\w-]+=/, ''));
    if (!/^(?:\.\.?\/)+/.test(path)) continue;
    const dir = protectedDataDir(normRoot(absolute(cwd, path)), roots);
    if (dir) return dir;
  }
  return '';
}

/** 命令行（Bash / PowerShell / cmd）：按文字匹配，只认明确指向受保护位置的写法。 */
export function checkCommand(command, roots, cwd) {
  if (!command || typeof command !== 'string') return '';
  const text = norm(command);
  const dir = dataDirIn(text, roots, cwd);
  if (dir) return dataReason(dir);
  if (/(?:appdata\/+local|%localappdata%|\$\{?localappdata\}?|\$env:localappdata)\/+zhixuerp/.test(text))
    return '不能读写 %LOCALAPPDATA%\\ZhixuERP 里的真实数据' + DATA_RULE;
  // 密钥：只允许作为 ssh/scp 的 -i 身份文件使用，其他提到 .pem 的命令（cat、复制、读取）都拦。
  for (const m of text.matchAll(/[^\s"'<>|;&]*\.pem\b/g)) {
    const before = text.slice(0, m.index);
    if (!/(?:^|\s)-i\s*["']?$/.test(before))
      return '不能读取、打印或复制密钥文件（.pem），密钥不进聊天和日志。用 ssh 连接时用 -i 指定即可。';
  }
  if (/(?:^|[\s"'=(;|&<>/])\.env(?:\.(?!example\b)[\w-]+)?(?=$|[\s"';|&)<>])/.test(text))
    return '不能读取或改动 .env，里面是密钥和本机配置，不进聊天和日志；参考字段看 .env.example。';
  const build =
    /\bnpm(?:\.cmd)?\s+(?:run|run-script)\s+build(?=$|[\s;&|)"'])/.test(text) ||
    /scripts\/build\.mjs/.test(text) ||
    (/\bvite(?:\.js)?["']?\s+build\b/.test(text) && !/--outdir|--out-dir/.test(text));
  if (build)
    return '正式实例可能在运行，这样构建会覆盖它正在用的 dist（AGENTS.md“用户说了才能做”）。构建检查输出到临时目录：npx vite build --outDir <临时目录> --emptyOutDir。';
  return '';
}

/** 每段命令按词匹配审批前缀，npm.cmd、git.exe 等同于无后缀的命令。 */
export function askReason(command, root) {
  if (!command || typeof command !== 'string') return '';
  const rules = readAskRules(root);
  let words = [];
  for (const token of shellTokens(command)) {
    if (/^[;&|\r\n(){}]$/.test(token)) {
      words = [];
      continue;
    }
    if (!words.length && /^[a-z_]\w*=/i.test(token)) continue;
    const word = unquote(token).toLowerCase();
    words.push(words.length ? word : win32.basename(word).replace(/\.(?:cmd|exe)$/, ''));
    const hit = rules.find(({ prefix }) =>
      prefix.length === words.length && prefix.every((part, i) => words[i] === part),
    );
    if (hit)
      return '“' + hit.prefix.join(' ') + '”要用户同意才能做（AGENTS.md“用户说了才能做”），请用户确认。';
  }
  return '';
}
