// 挡板规则（三家共用，判断只写在这里；命令怎么拆成段和词在 shell-words.mjs）：把 AGENTS.md“碰不得的”里能机器判断的几条变成挡板。
// 拦（deny）：读写真实数据和本机受保护目录（含连带整个 data/、backups/ 的删除、复制：根目录、通配、git clean -x、git stash -a、
// find -delete）、密钥和 .env、覆盖 dist 的构建、启动正式服务和动真实数据的维护命令、
// 不经 npm test 直接跑测试、改定下不许改的文件（文件工具和命令行写入都算）、往代码检查里登记豁免。
// 先问（ask）：连正式实例的地址、启停正式实例（本机的停止、服务器上的正式服务）、连真实模型的脚本、改检查的配置；
// 命令前缀清单另在 .claude/settings.json 的 permissions.ask。
// 只拦明确命中的路径和命令。路径按长名比：Windows 的 8.3 短名（ADMINI~1）先展开成长名，两种写法都查。
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, posix, resolve, win32 } from 'node:path';
import { commandSegments, commandName, programOf, shellTokens, unquote } from './shell-words.mjs';

const DATA_RULE = '（AGENTS.md“碰不得的”）。测试用 :memory: 或临时目录配虚构数据；确实要动真实数据请用户自己操作。';
const DATA_DIRS = ['data', 'backups'];
/** 本机数据目录（%LOCALAPPDATA%）下不能碰的目录（小写）和理由 */
const LOCAL_DIRS = {
  zhixuerp: '不能读写 %LOCALAPPDATA%\\ZhixuERP 里的真实数据' + DATA_RULE,
  'erp-real-model-test':
    '不能读、打印或复制真实模型测试实例存密钥的目录（%LOCALAPPDATA%\\erp-real-model-test），命令行里也不写它的路径，preview.mjs 自己拼（.claude/skills/ui-check/SKILL.md“真实模型模式”）。',
  '甬勒erp测试':
    '不能动本机装的桌面测试版（%LOCALAPPDATA%\\甬勒ERP测试），安装验证由人做（apps/desktop/docs/README.md）。',
};
const LOCAL_IN_COMMAND = new RegExp(
  '(?:appdata/+local|%localappdata%|\\$\\{?localappdata\\}?|\\$env:localappdata)/+(' +
    Object.keys(LOCAL_DIRS).join('|') + ')',
);
/** 定下不许改的文件（相对项目根目录，小写）；existing 的只拦改已有的，新加配置库要导出新的基线快照 */
const LOCKED = [
  {
    path: 'tests/fixtures/schema-v20.sql',
    reason: '第 20 版结构快照已发布，不许改；改结构在 server/core/schema/steps.ts 末尾加编号的升级步骤（.claude/skills/schema-change/SKILL.md）。',
  },
  {
    path: 'tests/fixtures/config-db/',
    existing: true,
    reason: '配置库的基线快照定下以后不许改；改配置库在它规格的 steps 末尾加一步（规矩在 server/core/backup/versioned-sqlite-spec.ts 开头）。',
  },
  {
    path: 'eslint-suppressions.json',
    reason: 'eslint-suppressions.json 已清空，不许往里登记：报错就改代码（docs/架构/代码检查.md“检查是防火墙”）。',
  },
];
/** 检查的配置（相对项目根目录，小写）：改它可能放宽或关掉自动检查，要用户同意 */
const CHECK_CONFIGS = [
  'eslint.config.js',
  'scripts/eslint-local-rules.mjs',
  'stylelint.config.mjs',
  '.jscpd.json',
  'knip.json',
  'scripts/complexity-baseline.json',
  'scripts/check.mjs',
];
/** 正式实例的地址（真实数据），只在用户要求时只读查看 */
const OFFICIAL_INSTANCE = /(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0):3001(?!\d)/i;
/** 服务器上正式服务的启停（服务名见 docs/运维/部署.md） */
const OFFICIAL_SERVICE = /systemctl\s+(?:start|stop|restart|kill|reload)\s+yongle-carton-erp\b/i;

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

/**
 * 带 8.3 短名（ADMINI~1、纸箱厂~1）的绝对路径展开成长名：存在的最长前缀交给系统展开，其余照接。
 * 没有短名写法的、展开不了的原样返回。路径的两种写法都要查，展开只多拦、不少拦。
 */
export function longPath(path) {
  if (!/~\d/.test(path)) return path;
  const api = WINDOWS_PATH.test(path) ? win32 : posix;
  try {
    for (let head = path, tail = ''; ; ) {
      if (existsSync(head)) return api.join(realpathSync.native(head), tail);
      const parent = api.dirname(head);
      if (parent === head) return path;
      tail = api.join(api.basename(head), tail);
      head = parent;
    }
  } catch {
    return path;
  }
}

/** 一个绝对路径要比对的写法：原样和展开短名后的（统一成 norm 的样子） */
const pathForms = (abs) => [...new Set([abs, longPath(abs)].map(normRoot))];

function protectedDataDir(abs, roots) {
  for (const root of roots)
    for (const dir of DATA_DIRS)
      if (abs === root + '/' + dir || abs.startsWith(root + '/' + dir + '/'))
        return dir;
  return '';
}

const dataReason = (dir) => '不能读写真实业务数据目录 ' + dir + '/' + DATA_RULE;

/** 统一过的绝对路径碰到的受保护位置：拦下的理由，没碰到返回空串 */
function pathReason(abs, roots) {
  const dir = protectedDataDir(abs, roots);
  if (dir) return dataReason(dir);
  const local = /\/appdata\/local\/([^/]+)/.exec(abs)?.[1];
  if (local && Object.hasOwn(LOCAL_DIRS, local)) return LOCAL_DIRS[local];
  if (/\.pem$/.test(abs)) return '不能读取或改动密钥文件（.pem），密钥不进聊天和日志。';
  if (/\/\.env(\.[a-z0-9_-]+)?$/.test(abs) && !abs.endsWith('/.env.example'))
    return '不能读取或改动 .env，里面是密钥和本机配置，不进聊天和日志；参考字段看 .env.example。';
  return '';
}

/** 文件类工具给的路径：解析成绝对路径后比对（短名写法展开后也比一遍）。 */
export function checkPath(raw, roots, cwd) {
  if (!raw || typeof raw !== 'string') return '';
  return pathForms(absolute(cwd, raw)).map((abs) => pathReason(abs, roots)).find(Boolean) || '';
}

/** 写入的路径相对哪个项目根目录（小写、正斜杠），不在项目里返回 null */
function inProject(raw, roots, cwd) {
  if (!raw || typeof raw !== 'string') return null;
  for (const abs of pathForms(absolute(cwd, raw))) {
    const root = roots.find((r) => abs.startsWith(r + '/'));
    if (root) return abs.slice(root.length + 1);
  }
  return null;
}

/** 写入定下不许改的文件：拦下的理由；可以写返回空串 */
export function lockedReason(raw, roots, cwd) {
  const rel = inProject(raw, roots, cwd);
  if (rel === null) return '';
  const hit = LOCKED.find(({ path }) => (path.endsWith('/') ? rel.startsWith(path) : rel === path));
  if (!hit || (hit.existing && !existsSync(absolute(cwd, raw)))) return '';
  return hit.reason;
}

/** 写入检查的配置：要用户确认的理由；不是返回空串 */
export function checkConfigReason(raw, roots, cwd) {
  const rel = inProject(raw, roots, cwd);
  if (rel === null || !CHECK_CONFIGS.includes(rel)) return '';
  return '改 ' + rel + ' 可能放宽或关掉自动检查，要用户同意才能改（AGENTS.md“碰不得的”），请用户确认。';
}

/** 连正式实例、启停服务器上的正式服务（命令文字或浏览器地址）：要用户确认的理由 */
export function officialInstanceReason(text) {
  if (typeof text !== 'string') return '';
  if (OFFICIAL_SERVICE.test(text))
    return '这是启停服务器上的正式实例，要用户同意才能做（AGENTS.md“碰不得的”），请用户确认。';
  if (!OFFICIAL_INSTANCE.test(text)) return '';
  return '127.0.0.1:3001 是正式实例（真实数据），只在用户要求时只读查看，请用户确认；平时用测试实例（.claude/skills/ui-check/SKILL.md）。';
}

/** 删、复制、搬、改名、打包、列目录、读文件的程序：后面裸写的 data、backups 也按当前目录解析 */
const DIR_PROGRAMS = new Set([
  'rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'rimraf', 'del-cli', 'trash',
  'cp', 'copy', 'copy-item', 'cpi', 'xcopy', 'robocopy', 'rsync', 'mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rni', 'tar', 'zip', '7z', 'compress-archive',
  'ls', 'dir', 'get-childitem', 'gci', 'tree', 'du', 'cat', 'type', 'get-content', 'gc', 'sqlite3', 'chmod', 'icacls', 'attrib',
]);
const GIT_DIR_COMMANDS = new Set(['rm', 'mv']);
/** 代码里（node -e 这类）对裸写的 'data'、'backups' 动手的函数 */
const CODE_ON_DIR =
  /\b(?:rm|rmdir|cp|rename|readdir|readfile|writefile|copyfile|opendir|unlink|stat|lstat|exists|access|createreadstream|createwritestream|join|resolve|glob)(?:sync)?\s*\(\s*(["'`])(?:\.\/)?(data|backups)\/?\1/;

/** 命令文字里碰到真实数据目录：相对路径、进目录、项目根目录（各个）的绝对路径、删搬列这类命令裸写的目录名 */
function dataDirIn(text, roots, cwd) {
  // 相对路径：data/…、./data/…、backups\…；前面必须是命令行分隔，src/data/ 这类不算。
  const relative = /(?:^|[\s"'=(;|&<>,])(?:\.\/)?(data|backups)\//.exec(text);
  // 进入目录：cd data、Set-Location backups
  const enter = /(?:^|[\s;&|(])(?:cd|pushd|set-location|sl)\s+["']?(?:\.\/)?(data|backups)["']?(?=$|[\s;&|)])/.exec(text);
  const hit = relative || enter || CODE_ON_DIR.exec(text);
  if (hit) return hit.at(-1);
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
  // rm -rf data、Copy-Item data D:\x：删搬列这类命令后面的每个参数都按当前目录解析
  for (const words of commandSegments(text)) {
    const { name, rest, sub } = programOf(words);
    if (!DIR_PROGRAMS.has(name) && !GIT_DIR_COMMANDS.has(sub)) continue;
    const dir = dirArgument(rest, roots, cwd);
    if (dir) return dir;
  }
  return '';
}

const EXCLUDE = /^-{1,2}exclude(?:-from)?$/;
/** 删搬列这类命令的参数里按当前目录解析后落在真实数据目录的；排除用的（robocopy /XD a b、--exclude data）不算 */
function dirArgument(rest, roots, cwd) {
  const inData = (path) => pathForms(absolute(cwd, path)).map((abs) => protectedDataDir(abs, roots)).find(Boolean);
  let skip = 0;
  for (const word of rest) {
    // robocopy /XD、/XF：到下一个开关为止都是排除的；--exclude、-Exclude 只排除后面一个
    if (/^\/x[df]$/.test(word)) skip = Infinity;
    else if (EXCLUDE.test(word)) skip = 1;
    else if (/^-|^\/[a-z]+(?::\S*)?$/.test(word)) {
      skip = 0;
      // -Path:data、--file=data 取等号后面的值；--exclude=data 不算
      const option = /^-{1,2}([\w-]+)[=:](.+)$/.exec(word);
      const dir = option && !EXCLUDE.test('--' + option[1]) ? inData(option[2]) : '';
      if (dir) return dir;
    } else if (skip) skip -= 1;
    else if (inData(word)) return inData(word);
  }
  return '';
}

/** 一段路径（小写）和通配写法比：* ? [] {a,b} 照 shell 的意思，** 什么都配 */
function segmentMatches(pattern, name) {
  if (pattern === name) return true;
  if (!/[*?[{]/.test(pattern)) return false;
  const source = pattern
    .replace(/[.+^$()|\\]/g, '\\$&')
    .replace(/\*+/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\[!/g, '[^')
    .replace(/\{([^}]*)\}/g, (_, list) => '(?:' + list.split(',').join('|') + ')');
  try {
    return new RegExp('^' + source + '$').test(name);
  } catch {
    return true;
  }
}

/** 这个路径（可带通配）是项目根目录、根目录的上级，或通配写法盖住了根目录下的 data、backups */
function sweepsData(abs, roots) {
  const segments = abs.split('/');
  return roots.some((root) => {
    const rootSegments = root.split('/');
    for (let i = 0; i < segments.length; i++) {
      if (i === rootSegments.length) return DATA_DIRS.some((dir) => segmentMatches(segments[i], dir));
      if (!segmentMatches(segments[i], rootSegments[i])) return false;
    }
    return true;
  });
}

/** 删、搬、复制、打包的程序：参数是根目录、它的上级或通配写法时会连带 data、backups（复制和搬只看来源，最后一个是目标） */
const SWEEP_DELETE = new Set([
  'rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'rimraf', 'del-cli', 'trash',
  'ren', 'rename', 'rename-item', 'rni', 'tar', 'zip', '7z', 'compress-archive',
]);
const SWEEP_COPY = new Set(['cp', 'copy', 'copy-item', 'cpi', 'xcopy', 'robocopy', 'rsync', 'mv', 'move', 'move-item', 'mi']);
const SWEEP_REASON =
  '会连带真实业务数据目录 data/、backups/ 一起删掉、搬走或复制出去（项目根目录、它的上级或通配写法）' + DATA_RULE +
  '只点名要动的文件或目录；不以项目根目录为来源复制（AGENTS.md“常用命令”）。';
const GIT_SWEEP_REASON =
  'git clean -x/-X 和 git stash -a/--all 会连被忽略的 data/、backups/ 一起删掉' + DATA_RULE +
  '清没跟踪的文件用 git clean -fd（不带 x），先 git clean -n 看要删哪些。';

/** 一段的参数（去掉开关，-Path:x、--file=x 取值；排除用的、-Destination 指的目标不算） */
function argumentsOf(rest) {
  const out = [];
  let skip = 0;
  for (const word of rest) {
    if (/^\/x[df]$/.test(word)) skip = Infinity;
    else if (EXCLUDE.test(word) || /^-destination(?:path)?$/.test(word)) skip = 1;
    else if (/^-|^\/[a-z]+(?::\S*)?$/.test(word)) {
      skip = 0;
      const option = /^-{1,2}([\w-]+)[=:](.+)$/.exec(word);
      if (option && !/^(?:exclude(?:-from)?|destination(?:path)?)$/.test(option[1])) out.push(option[2]);
    } else if (skip) skip -= 1;
    else out.push(word);
  }
  return out;
}

/** git clean 带 x（-x、-X、-fdx 合写，不是只看的 -n）、git stash 带 -a/--all：目录在项目里或是根目录的上级就拦 */
function gitSweeps({ sub, subArgs, gitDir }, roots, cwd) {
  const flags = subArgs.filter((word) => /^-[^-]/.test(word)).join('');
  const clean = sub === 'clean' && /x/.test(flags) && !/n/.test(flags) && !subArgs.includes('--dry-run');
  const stash = sub === 'stash' && (/a/.test(flags) || subArgs.includes('--all'));
  if (!clean && !stash) return false;
  const dir = absolute(cwd, gitDir || '.');
  const inside = (abs) => roots.some((root) => abs === root || abs.startsWith(root + '/'));
  if (pathForms(dir).some((abs) => inside(abs) || sweepsData(abs, roots))) return true;
  return clean && subArgs.filter((word) => !word.startsWith('-')).some((word) =>
    word.startsWith(':/') || pathForms(absolute(dir, word)).some((abs) => sweepsData(abs, roots)));
}

/** find 带 -delete 或 -exec rm：起点（不写是当前目录）是根目录、它的上级或盖住 data、backups 就拦 */
function findSweeps(rest, text, roots, cwd) {
  if (!/\s-delete\b|\s-(?:exec|execdir|ok)\s+(?:\S*\/)?(?:rm|rmdir|unlink|shred|mv)\b/.test(text)) return false;
  const option = rest.findIndex((word) => /^[-!\\]/.test(word));
  const starts = option < 0 ? rest : rest.slice(0, option);
  return (starts.length ? starts : ['.']).some((word) =>
    pathForms(absolute(cwd, word)).some((abs) => sweepsData(abs, roots)));
}

/** 一条命令会不会连带整个 data、backups 一起删、搬、复制：拦下的理由，不会返回空串 */
function sweepReason(text, roots, cwd) {
  // shell 的花括号展开（rm -rf {data,tmp}）先展开成几个词，花括号在拆段时会被当成分隔
  const expanded = text.replace(/([^\s{}]*)\{([^{}\s]*,[^{}\s]*)\}([^\s{}]*)/g, (_, head, list, tail) =>
    list.split(',').map((item) => head + item + tail).join(' '));
  for (const words of commandSegments(expanded)) {
    const program = programOf(words);
    if (program.name === 'git' && gitSweeps(program, roots, cwd)) return GIT_SWEEP_REASON;
    if (program.name === 'find' && findSweeps(program.rest, text, roots, cwd)) return SWEEP_REASON;
    if (!SWEEP_DELETE.has(program.name) && !SWEEP_COPY.has(program.name)) continue;
    const args = argumentsOf(program.rest);
    const destination = program.rest.some((word) => /^-destination(?:path)?(?:[=:]|$)/.test(word));
    const sources = SWEEP_COPY.has(program.name) && !destination && args.length > 1 ? args.slice(0, -1) : args;
    const swept = sources.some((word) => pathForms(absolute(cwd, word)).some((abs) => sweepsData(abs, roots)));
    if (swept) return SWEEP_REASON;
  }
  return '';
}

/** 命令文字里带 ~数字 的路径换成展开短名后的绝对路径，别的原样 */
const longPathsIn = (command, cwd) =>
  command.replace(/[^\s"'`;|&<>(){}=,]*~\d[^\s"'`;|&<>(){}]*/g, (word) => {
    const abs = absolute(cwd, word);
    const long = longPath(abs);
    return long === abs ? word : long;
  });

/** 命令行（Bash / PowerShell / cmd）：按文字匹配，只认明确指向受保护位置的写法；带短名的路径展开后再查一遍。 */
export function checkCommand(command, roots, cwd) {
  if (!command || typeof command !== 'string') return '';
  const reason = commandReason(command, roots, cwd);
  if (reason) return reason;
  const long = longPathsIn(command, cwd);
  return long === command ? '' : commandReason(long, roots, cwd);
}

function commandReason(command, roots, cwd) {
  const text = norm(command);
  const dir = dataDirIn(text, roots, cwd);
  if (dir) return dataReason(dir);
  const sweep = sweepReason(text, roots, cwd);
  if (sweep) return sweep;
  const local = LOCAL_IN_COMMAND.exec(text);
  if (local) return LOCAL_DIRS[local[1]];
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
    return '正式实例可能在运行，这样构建会覆盖它正在用的 dist（AGENTS.md“碰不得的”）。构建检查输出到临时目录：npx vite build --outDir <临时目录> --emptyOutDir。';
  return runReason(text, cwd);
}

const SERVICE_RULE =
  '会按真实目录启动正式服务（AGENTS.md“碰不得的”）。看代码能不能加载用 npx tsc --noEmit；要起实例用测试实例（.claude/skills/ui-check/SKILL.md）。';
const MAINTENANCE_RULE = '是对真实数据的维护命令（AGENTS.md“碰不得的”），要做请用户自己操作。';
/** 一段命令里用 node、tsx 这类运行器跑脚本 */
const RUNNER = /(?:^|[\s"'(/])(?:node|tsx|bun|deno|ts-node)(?:\.exe|\.cmd)?["']?(?=\s)/;
/** 运行器后面跟着这些入口就拦：正式服务的入口、启动脚本、真实数据的维护脚本 */
const ENTRIES = [
  [/(?<![\w-])server\/index(?:\.[cm]?[jt]s)?(?![\w.-])/, '加载或运行 server/index.ts ' + SERVICE_RULE],
  [/scripts\/(?:start|dev)-system\.mjs/, '运行启动脚本' + SERVICE_RULE],
  [/(?<![\w-])server\/maintenance(?:\.[cm]?[jt]s)?(?![\w.-])/, 'server/maintenance.ts ' + MAINTENANCE_RULE],
];
/** npm 和子命令之间、run 和脚本名之间可以夹 -s、--silent、--loglevel=error 这类开关 */
const NPM_OPTIONS = '(?:\\s+-{1,2}[\\w-]+(?:=\\S*)?)*';
const NPM_RUN = '\\bnpm(?:\\.cmd)?' + NPM_OPTIONS + '\\s+';
const SCRIPT_END = '(?=$|[\\s;&|)"\'])';
const NPM_SCRIPT = new RegExp(
  NPM_RUN + '(?:(start|restart)|(?:run|run-script)' + NPM_OPTIONS +
    '\\s+(start|restart|dev|backup|restore|reset-password|revert-config-upgrades))' + SCRIPT_END,
);
const NPM_STOP = new RegExp(NPM_RUN + '(?:stop|(?:run|run-script)' + NPM_OPTIONS + '\\s+stop)' + SCRIPT_END);
/** 四个数据目录都指到临时目录才能直接跑 --test（AGENTS.md“常用命令”） */
const TEST_DIRS = ['localappdata', 'erp_config_dir', 'db_path', 'erp_backup_dir'].map(
  (name) => new RegExp('(?:^|[\\s;&|("\'])(?:\\$env:)?' + name + '\\s*='),
);

/** 启动正式服务、动真实数据的维护命令、不经 npm test 的测试、往代码检查里登记豁免 */
function runReason(text, cwd) {
  const script = NPM_SCRIPT.exec(text);
  if (script) {
    const name = script[1] || script[2];
    return ['start', 'restart', 'dev'].includes(name)
      ? 'npm ' + (script[1] ? '' : 'run ') + name + ' ' + SERVICE_RULE
      : 'npm run ' + name + ' ' + MAINTENANCE_RULE;
  }
  // 双击启动的脚本和直接跑启动脚本（cmd /c 启动系统.cmd、& .\启动系统.cmd、Start-Process）
  for (const words of commandSegments(text)) {
    const { name, word } = programOf(words);
    if (name === '启动系统' || /scripts\/(?:start|dev)-system\.mjs$/.test(word)) return '运行启动脚本' + SERVICE_RULE;
  }
  const sandboxed = TEST_DIRS.every((dir) => dir.test(text));
  for (const segment of text.split(/[;&|\r\n]+/)) {
    if (!RUNNER.test(segment)) continue;
    const entry = ENTRIES.find(([pattern]) => pattern.test(segment));
    if (entry) return entry[1];
    // 外壳 apps/ 的测试自成一体，不碰 ERP 的数据目录
    const bareTest = /\s--test(?=$|[\s=])/.test(segment) && !sandboxed
      && !/(?:^|[\s"'/])apps\//.test(text) && !/\/apps\//.test(norm(cwd));
    if (bareTest)
      return '直接跑 --test 没把 LOCALAPPDATA、ERP_CONFIG_DIR、DB_PATH、ERP_BACKUP_DIR 四个都指到临时目录，会碰到本机真实数据（AGENTS.md“碰不得的”）。用 npm test -- <测试文件>，它会把数据、配置、备份目录都指进临时目录。';
  }
  if (/--suppress-(?:all|rule)\b/.test(text) && /eslint|npm(?:\.cmd)?\s+run\s+lint/.test(text))
    return 'eslint-suppressions.json 已清空，不许往里登记：报错就改代码（docs/架构/代码检查.md“检查是防火墙”）。';
  return '';
}

const STOP_REASON = '这会停掉本机的正式实例，要用户同意才能做（AGENTS.md“碰不得的”），请用户确认。';
const REAL_MODEL_REASON =
  '这是连真实模型的脚本，会花钱，要用户同意才能跑（AGENTS.md“碰不得的”），请用户确认；自测用假模型（.claude/skills/ui-check/SKILL.md）。';

/** 停本机正式实例、连真实模型（花钱）的命令：要用户确认的理由，三家都由挡板判（前缀清单只认一种写法） */
export function commandAskReason(command) {
  if (!command || typeof command !== 'string') return '';
  const text = norm(command);
  if (NPM_STOP.test(text) || commandSegments(text).some((words) => programOf(words).name === '停止系统'))
    return STOP_REASON;
  for (const segment of text.split(/[;&|\r\n]+/)) {
    if (!RUNNER.test(segment)) continue;
    if (/(?<![\w-])server\/stop(?:\.[cm]?[jt]s)?(?![\w.-])/.test(segment)) return STOP_REASON;
    // 只认文件名：cd scripts/ui-check 以后 node real-smoke.mjs 也算
    const realModel = /(?:^|[\s"'/])real-(?:smoke|suite|recognition)\.mjs/.test(segment);
    if (realModel && /\s--(?:yes|start)(?=$|[\s=])/.test(segment)) return REAL_MODEL_REASON;
  }
  return '';
}

/** 程序名后、子命令前带值的开关（git -C 目录、git -c 键=值、npm --prefix 目录、gh -R 仓库），跳过时连值一起跳 */
const VALUE_OPTIONS = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--prefix', '-w', '--workspace', '-r', '--repo']);

/**
 * 每段命令按词匹配审批前缀：npm.cmd、git.exe 等同于无后缀的命令；跳过前置的环境变量赋值和子命令前的开关
 * （git -C . push、npm --save-dev install）；powershell -c "…" 这类引号里的命令另算一段。
 */
export function askReason(command, root) {
  if (!command || typeof command !== 'string') return '';
  const rules = readAskRules(root);
  for (const segment of commandSegments(command)) {
    const words = segment.map((word) => word.toLowerCase());
    let i = 0;
    while (i < words.length && /^[a-z_]\w*=/.test(words[i])) i += 1;
    if (i >= words.length) continue;
    let next = i + 1;
    while (next < words.length && words[next].startsWith('-')) next += VALUE_OPTIONS.has(words[next]) ? 2 : 1;
    const line = [commandName(words[i]), ...words.slice(next)];
    const hit = rules.find(({ prefix }) => prefix.every((part, k) => line[k] === part));
    if (hit)
      return '“' + hit.prefix.join(' ') + '”要用户同意才能做（AGENTS.md“碰不得的”），请用户确认。';
  }
  return '';
}
