// 命令文字拆成一段段命令和词，给 rules.mjs、data-commands.mjs 判断用：这里只管怎么拆、哪个词是真正跑的程序、
// 命令会写到哪些路径，不管拦什么。
import { win32 } from 'node:path';

// 引号里的分隔符是参数文字。括号和花括号可包住一整段命令。
export const shellTokens = (text) => text.match(/(?:"[^"]*"|'[^']*'|[^\s"';&|<>(){}])+|[;&|\r\n(){}]/g) ?? [];
export const unquote = (word) => word.replace(/^(["'])(.*)\1$/, '$2');

const SEPARATOR = /^[;&|\r\n(){}]$/;
/** 再起一层命令行的程序：它们 -c、/c 后面引号包住的整段命令另拆成段 */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'cmd', 'powershell', 'pwsh', 'wsl', 'npx']);
const INNER_FLAG = /^(?:-c|-command|\/c|\/k)$/i;

/** 程序名：去掉目录、.exe、.cmd、.bat，小写 */
export const commandName = (word) => win32.basename(word).toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '');

/**
 * 命令文字拆成段（按 ; & | 换行、括号分），每段是去掉引号的词，另给这段前面的分隔：'' 开头、'&&'、';'、'\n'、'|'、'||'、'&'、
 * 括号，几个连着的写在一起；powershell -c "…" 这类引号里另拆出的段是 'inner'。
 */
export function commandSteps(text) {
  const steps = [];
  let words = [];
  let before = '';
  let pending = '';
  for (const token of shellTokens(text)) {
    if (SEPARATOR.test(token)) {
      if (words.length) steps.push({ words, before });
      words = [];
      if (token !== '\r') pending += token;
      continue;
    }
    if (!words.length) [before, pending] = [pending, ''];
    const word = unquote(token);
    if (word !== token && words.length && SHELLS.has(commandName(words[0])) && INNER_FLAG.test(words.at(-1)))
      steps.push(...commandSteps(word).map((step) => ({ ...step, before: 'inner' })));
    words.push(word);
  }
  if (words.length) steps.push({ words, before });
  return steps;
}

/** 命令文字拆成段，每段是去掉引号的词 */
export const commandSegments = (text) => commandSteps(text).map((step) => step.words);

/**
 * 只是换个方式启动后面那个程序的词（sudo、cmd /c、Start-Process、&、npx、shx、xargs 等），连同它们的开关、--
 * 和前置的环境变量赋值都跳过；npm exec、pnpm dlx 这类两个词的一起跳；npx -p 包名、xargs -n 1 这类带值的开关连值一起跳。
 */
const LAUNCHERS = new Set([
  'sudo', 'cmd', 'call', 'start', 'start-process', 'saps', 'invoke-item', 'ii', 'nohup', 'exec', 'command', 'env', 'time',
  'powershell', 'pwsh', '.', 'npx', 'bunx', 'shx', 'xargs',
]);
const LAUNCHER_VALUES = {
  npx: /^(?:-p|--package)$/i,
  bunx: /^(?:-p|--package)$/i,
  sudo: /^-[ug]$/,
  xargs: /^-[nILPsdEa]$/,
};
const PACKAGE_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const RUN_VERBS = new Set(['exec', 'dlx', 'x']);
const SKIPPED = /^(?:\/[a-z]|-{1,2}[a-z][\w-]*|--|[a-z_]\w*=.*|)$/i;

/** 一段里真正跑的程序是第几个词 */
function programAt(words) {
  let i = 0;
  let launcher = '';
  while (i < words.length) {
    const name = commandName(words[i]);
    if (PACKAGE_RUNNERS.has(name) && RUN_VERBS.has(commandName(words[i + 1] ?? ''))) i += 2;
    else if (LAUNCHERS.has(name)) [launcher, i] = [name, i + 1];
    else if (LAUNCHER_VALUES[launcher]?.test(words[i])) i += 2;
    else if (SKIPPED.test(words[i])) i += 1;
    else break;
  }
  return i;
}

/** git 子命令前带值的开关：-C 目录、-c 键=值（小写以后分不开，值里有 = 的是 -c）、--git-dir 目录等 */
const GIT_VALUE_OPTION = /^(?:-c|--git-dir|--work-tree|--namespace)$/i;

/** 一段的程序名；git 另给子命令（git rm 这类）、子命令后面的词和 -C 指的目录 */
export function programOf(words) {
  const at = programAt(words);
  const name = commandName(words[at] ?? '');
  const rest = words.slice(at + 1);
  let k = 0;
  let gitDir = '';
  while (name === 'git' && k < rest.length && rest[k].startsWith('-')) {
    if (GIT_VALUE_OPTION.test(rest[k])) {
      if (/^-c$/i.test(rest[k]) && !rest[k + 1]?.includes('=')) gitDir = rest[k + 1] ?? '';
      k += 1;
    }
    k += 1;
  }
  const sub = name === 'git' ? commandName(rest[k] ?? '') : '';
  return { name, word: words[at] ?? '', rest, sub, subArgs: sub ? rest.slice(k + 1) : [], gitDir };
}

/** 一个词里可能是路径的写法：去掉 -Path:、--file=、NAME= 前缀的本身，和它里面引号包住的字符串（node -e 的代码） */
const pathsIn = (word) => [
  word.replace(/^(?:-{1,2}[\w-]+[=:]|[a-z_]\w*=)/i, ''),
  ...[...word.matchAll(/["'`]([^"'`\s]+)["'`]/g)].map((m) => m[1]),
];

/** 写文件、删、搬、改名的程序：段里提到的路径都算写 */
const WRITERS = new Set([
  'set-content', 'sc', 'add-content', 'ac', 'out-file', 'clear-content', 'clc', 'new-item', 'ni', 'tee', 'tee-object',
  'rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri', 'mv', 'move', 'move-item', 'mi',
  'ren', 'rename', 'rename-item', 'rni', 'truncate', 'touch', 'unlink', 'shred', 'dd', 'rimraf', 'del-cli', 'trash',
]);
const GIT_WRITERS = new Set(['rm', 'mv', 'checkout', 'restore']);
/** 原地改的程序（带 -i 才算） */
const IN_PLACE = new Set(['sed', 'perl']);
/** 复制的程序：只有目标（最后一个、或 -Destination 后面那个）算写 */
const COPIERS = new Set(['cp', 'copy', 'copy-item', 'cpi', 'xcopy', 'robocopy', 'rsync', 'install']);
/**
 * 代码里写、删、改名文件的函数：node -e 的 fs、PowerShell 的 [IO.File]::WriteAllText、python 的 write_text 和
 * open(…, 'w'/'a'/'x'/'+')。命令里有一处，整条命令提到的路径都算写（函数和路径可能被括号分到不同段里），
 * 只在只读调用里出现的除外（见 readOnly）。
 */
const CODE_WRITES = new RegExp(
  '\\b(?:(?:write|append|copy)file|rm|rmdir|unlink|rename|truncate|cp|createwritestream' +
    '|writeall(?:text|bytes|lines)|appendall(?:text|lines)|write_(?:text|bytes))(?:sync)?\\s*\\(' +
    '|\\bopen\\s*\\([^)]*?,\\s*(?:mode\\s*=\\s*)?["\'][rbt]*[wax+]',
  'i',
);
/** 代码里只读的调用，第 2 组是路径：readFileSync('x')、ReadAllText('x')、existsSync('x')、open('x')（不带写模式）、Path('x').read_text() */
const READ_CALLS = [
  /\b(?:readfile(?:sync)?|createreadstream|readall(?:text|bytes|lines)|(?:exists|stat|lstat|access)sync|readlines)\s*\(\s*(["'`])([^"'`]+)\1\s*[,)]/gi,
  /\bopen\s*\(\s*(["'])([^"']+)\1\s*(?:,\s*(?:mode\s*=\s*)?["'][rbt]*["']\s*)?\)/gi,
  /\bpath\s*\(\s*(["'])([^"']+)\1\s*\)\s*\.(?:read_(?:text|bytes)|exists|stat)\s*\(/gi,
];

/** 一条命令里哪些路径只出现在只读调用里（每一处都是）：这些不算写 */
function readOnly(text) {
  const reads = new Map();
  for (const pattern of READ_CALLS) for (const m of text.matchAll(pattern)) reads.set(m[2], (reads.get(m[2]) ?? 0) + 1);
  const everywhere = (path) => {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return (text.match(new RegExp('(?<![\\w./\\\\-])' + escaped + '(?![\\w./\\\\-])', 'g')) ?? []).length;
  };
  return (path) => reads.has(path) && reads.get(path) === everywhere(path);
}

/** 重定向：> 和 >> 后面的目标（2>&1 不算，=> 和 -> 不算） */
const REDIRECT = /(?:^|[^-=<>\d*])[\d*]?>>?\s*(?!&)("[^"]*"|'[^']*'|[^\s;&|<>()]+)/g;

/** 正文里会执行的命令替换：$( … )（括号套几层都认，里外层各算一条）和（shell 里的）反引号 */
function substitutions(body, backticks) {
  const out = [];
  for (let start = body.indexOf('$('); start >= 0; start = body.indexOf('$(', start + 2)) {
    let depth = 0;
    let end = start + 1;
    for (; end < body.length; end++) {
      if (body[end] === '(') depth += 1;
      else if (body[end] === ')' && (depth -= 1) === 0) break;
    }
    out.push(body.slice(start + 2, end));
  }
  if (backticks) out.push(...[...body.matchAll(/`([^`]*)`/g)].map((m) => m[1]));
  return out;
}
/** 把 here-string 当脚本执行的写法 */
const EXECUTES = /\b(?:iex|invoke-expression|invoke-command)\b|\[scriptblock\]::create/i;
const HEREDOC = /^([^\r\n]*<<-?\s*(\\?)(["']?)(\w+)\3[^\r\n]*)\r?\n([\s\S]*?)\r?\n[ \t]*\4[ \t]*(?=\r?\n|$)/gm;

/**
 * 认写入时看的命令文字：写进文件的正文不是要跑的命令。
 * - cat、tee 的 heredoc：界定符带引号（<<'EOF'、<<"EOF"、<<\EOF）去掉正文；不带引号的只留 $( … ) 和反引号里的命令（shell 会执行）。
 * - PowerShell 的 here-string：整条命令把它交给 iex、Invoke-Command、[scriptblock]::Create 执行时，正文逐行当命令；
 *   不然 @'…'@ 去掉正文，@"…"@ 只留 $( … ) 里的命令。
 * 别的判断照旧扫原文。
 */
function writableText(command) {
  const text = command.replace(HEREDOC, (all, head, backslash, quote, _name, body) => {
    if (!['cat', 'tee'].includes(programOf(commandSegments(head).at(-1) ?? []).name)) return all;
    return backslash || quote ? head : [head, ...substitutions(body, true)].join('\n');
  });
  const executed = EXECUTES.test(text);
  return text.replace(/@(["'])\r?\n([\s\S]*?)\r?\n\1@/g, (all, quote, body) => {
    const commands = executed ? [body] : quote === '"' ? substitutions(body, false) : [];
    return ["''", ...commands, ''].join('\n');
  });
}

/** 命令会写到的路径（原样的写法，由判路径的函数去解析）：重定向目标、写删搬改名和原地改的命令提到的路径、复制的目标、代码里写文件 */
export function commandWrites(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const command = writableText(raw);
  const out = [...command.matchAll(REDIRECT)].map((m) => unquote(m[1]));
  const code = CODE_WRITES.test(command);
  const onlyRead = readOnly(command);
  for (const words of commandSegments(command)) {
    const { name, rest, sub } = programOf(words);
    const inPlace = IN_PLACE.has(name) && rest.some((word) => /^(?:-[a-z]*i|--in-place)/.test(word));
    if (WRITERS.has(name) || GIT_WRITERS.has(sub) || inPlace) {
      out.push(...words.flatMap(pathsIn));
      continue;
    }
    if (code) out.push(...words.flatMap(pathsIn).filter((path) => !onlyRead(path)));
    if (!COPIERS.has(name)) continue;
    const destination = rest.findIndex((word) => /^-destination$/i.test(word));
    const target = destination >= 0 ? rest[destination + 1] : rest.filter((word) => !word.startsWith('-')).at(-1);
    if (target) out.push(...pathsIn(target));
  }
  return out;
}
