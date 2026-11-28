// 跑脚本文件时扫脚本内容（protect-real-data.mjs 的 judge 调用）：
// - shell 脚本（sh/bash x.sh、powershell -File x.ps1、& ./x.ps1、cmd /c x.cmd、./x.sh）全文当命令文字，照命令行的规矩判；
// - 代码脚本（node/tsx/deno/bun/python 跑 .js/.mjs/.ts/.mts/.py）只看写死的：删、写、改名、复制文件的调用里写死的路径，
//   exec/spawn/os.system 里写死的命令文字。拼出来的路径、import 进来的文件、动态拼的命令不看（要真跑才知道）。
// 项目根目录里 git 跟踪着、和 HEAD 一样没改过的脚本不扫（经过审查；npm run 跑的本来也不经这里）；读不到、超过 1 MB 的不扫。
// 脚本里写死的相对路径按这条命令的当前目录解析（脚本里自己 chdir 的认不出）。
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { DATA_RULE, dataReason, norm, normRoot, pathForms, protectedDataDir, resolveArg, sweepsData } from './paths.mjs';
import { checkCommand, lockedReason } from './rules.mjs';
import { commandSteps, commandWrites, programOf } from './shell-words.mjs';
import { expand, variableValues } from './variables.mjs';

const SHELL_SCRIPT = /\.(?:sh|bash|ps1|cmd|bat)$/i;
const CODE_SCRIPT = /\.(?:[cm]?[jt]s|py)$/i;
const RUNNERS = new Set(['sh', 'bash', 'zsh', 'dash', 'powershell', 'pwsh', 'node', 'tsx', 'ts-node', 'deno', 'bun', 'python', 'python3', 'py']);
/** 运行器带值的开关：后面那个词不是要跑的脚本 */
const RUNNER_VALUE = /^(?:--import|-r|--require|--loader|--experimental-loader|-c|--conditions|--env-file|--input-type|--test-reporter|--test-reporter-destination)$/i;
const MAX_SIZE = 1024 * 1024;

/**
 * 代码里删、写、改名、复制文件的调用，写死的第一个参数（第 3 组）和复制、改名写死的第二个参数（第 5 组）；
 * 第 1 组是函数名（rm 一类的另看会不会连带整个目录）。
 */
const CODE_CALL = new RegExp(
  '\\b(rmsync|rmdirsync|unlinksync|rm|rmdir|unlink|writefilesync|appendfilesync|writefile|appendfile|truncatesync|truncate' +
    '|createwritestream|renamesync|rename|cpsync|cp|copyfilesync|copyfile|writealltext|writeallbytes|writealllines|appendalltext' +
    '|os\\.remove|os\\.unlink|os\\.rmdir|os\\.removedirs|shutil\\.rmtree|shutil\\.move|shutil\\.copy\\w*)' +
    '\\s*\\(\\s*(["\'`])([^"\'`$\\n{}]+)\\2(?:\\s*,\\s*(["\'`])([^"\'`$\\n{}]+)\\4)?',
  'gi',
);
const PY_PATH_CALL = /\bpath\s*\(\s*(["'])([^"'$\n]+)\1\s*\)\s*\.(unlink|rmdir|write_text|write_bytes)\s*\(/gi;
const PY_OPEN_WRITE = /\bopen\s*\(\s*(["'])([^"'$\n]+)\1\s*,\s*(?:mode\s*=\s*)?["'][rbt]*[wax+]/gi;
const DELETES = /^(?:rmsync|rmdirsync|unlinksync|rm|rmdir|unlink|os\.remove|os\.unlink|os\.rmdir|os\.removedirs|shutil\.rmtree|unlink)$/i;
const EXEC_CALL =
  /\b(?:execsync|exec|spawnsync|execfilesync|os\.system|subprocess\.(?:run|call|check_call|check_output|popen))\s*\(\s*(["'`])([^"'`$\n{}]+)\1/gi;
const SWEEP_REASON = '脚本里会连带真实业务数据目录 data/、backups/ 一起删掉（项目根目录或它的上级）' + DATA_RULE;

/** 这条命令要跑的脚本文件（写法原样，可能带变量） */
function scriptsIn(command) {
  const out = [];
  for (const { words } of commandSteps(norm(command, true))) {
    const program = programOf(words);
    if (SHELL_SCRIPT.test(program.word) || CODE_SCRIPT.test(program.word)) out.push(program.word);
    if (!RUNNERS.has(program.name)) continue;
    for (let i = 0; i < program.rest.length; i++) {
      const word = program.rest[i];
      if (RUNNER_VALUE.test(word)) i += 1;
      else if (SHELL_SCRIPT.test(word) || CODE_SCRIPT.test(word)) out.push(word);
    }
  }
  return out;
}

/** 在项目根目录里、git 跟踪着、和 HEAD 一样没改过 */
function cleanInProject(file, rawRoots) {
  const forms = pathForms(file);
  const root = rawRoots.find((raw) => forms.some((abs) => abs.startsWith(normRoot(raw) + '/')));
  if (!root) return false;
  try {
    const status = execFileSync('git', ['-C', root, 'status', '--porcelain', '--ignored', '--', file], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return status.trim() === '';
  } catch {
    return false;
  }
}

/** 从 start 的引号起，字符串结束后的位置（认反斜杠转义；单双引号的到行尾也算结束） */
function stringEnd(text, start) {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === quote) return i + 1;
    else if (quote !== '`' && text[i] === '\n') return i;
  }
  return text.length;
}

/** 正则字面量结束后的位置（认转义和 [...]，到行尾也算结束） */
function regexEnd(text, start) {
  let inClass = false;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '[') inClass = true;
    else if (text[i] === ']') inClass = false;
    else if (text[i] === '/' && !inClass) return i + 1;
    else if (text[i] === '\n') return i;
  }
  return text.length;
}

/**
 * 代码里哪些位置是代码本身（不在字符串、模板串、正则、注释里）：粗略的词法，JS 认行注释、块注释和正则，python 认 # 和三引号。
 * 测试和探针把整条命令写在字符串里，那些字符串里的调用不算。
 */
function codePositions(text, python) {
  const code = new Uint8Array(text.length);
  let previous = '';
  for (let i = 0; i < text.length; ) {
    const pair = text.slice(i, i + 2);
    const triple = text.slice(i, i + 3);
    let end = -1;
    if (!python && pair === '//') end = text.indexOf('\n', i);
    else if (!python && pair === '/*') end = text.indexOf('*/', i + 2) + 2;
    else if (python && text[i] === '#') end = text.indexOf('\n', i);
    else if (python && (triple === "'''" || triple === '"""')) end = text.indexOf(triple, i + 3) + 3;
    else if (text[i] === '"' || text[i] === "'" || text[i] === '`') end = stringEnd(text, i);
    else if (!python && text[i] === '/' && /^$|[(,=:[!&|?{};+\-*%<>~^]/.test(previous)) end = regexEnd(text, i);
    if (end !== -1) {
      i = end <= i ? text.length : end;
      previous = '"';
      continue;
    }
    code[i] = 1;
    if (!/\s/.test(text[i])) previous = text[i];
    i += 1;
  }
  return code;
}

/** 代码脚本里写死的路径和命令：拦下的理由（只看写在代码里的调用，字符串、注释里提到的不算） */
function codeReason(text, roots, cwd, python) {
  const code = codePositions(text, python);
  const inCode = (m) => code[m.index] === 1;
  const judgePath = (path, deletes) => {
    const forms = pathForms(resolveArg(cwd, path));
    const dir = forms.map((abs) => protectedDataDir(abs, roots)).find(Boolean);
    if (dir) return dataReason(dir);
    if (deletes && forms.some((abs) => sweepsData(abs, roots))) return SWEEP_REASON;
    return lockedReason(path, roots, cwd);
  };
  for (const m of [...text.matchAll(CODE_CALL)].filter(inCode)) {
    const reason = judgePath(m[3], DELETES.test(m[1])) || (m[5] ? judgePath(m[5], false) : '');
    if (reason) return reason;
  }
  for (const m of [...text.matchAll(PY_PATH_CALL)].filter(inCode)) {
    const reason = judgePath(m[2], /^(?:unlink|rmdir)$/i.test(m[3]));
    if (reason) return reason;
  }
  for (const m of [...text.matchAll(PY_OPEN_WRITE)].filter(inCode)) {
    const reason = judgePath(m[2], false);
    if (reason) return reason;
  }
  for (const m of [...text.matchAll(EXEC_CALL)].filter(inCode)) {
    const reason = checkCommand(m[2], roots, cwd);
    if (reason) return reason;
  }
  return '';
}

/** shell 脚本全文当命令：点名碰真实数据、连带整个目录、写锁定文件的拦 */
function shellReason(text, roots, cwd) {
  return checkCommand(text, roots, cwd) || commandWrites(text).map((path) => lockedReason(path, roots, cwd)).find(Boolean) || '';
}

/**
 * 命令里跑的脚本文件：读得到的照上面的规矩扫，拦下的理由带上是哪个脚本。roots 是统一过的根目录，
 * rawRoots 是原样的（给 git -C 用）。
 */
export function scriptReason(command, roots, rawRoots, cwd) {
  if (!command || typeof command !== 'string') return '';
  const values = variableValues(norm(command), cwd, norm(command, true));
  for (const word of scriptsIn(command)) {
    for (const path of expand(word, (name) => values.get(name.toLowerCase())) ?? []) {
      const file = resolveArg(cwd, path);
      const size = statSync(file, { throwIfNoEntry: false });
      if (!size?.isFile() || size.size > MAX_SIZE || cleanInProject(file, rawRoots)) continue;
      const text = readFileSync(file, 'utf8');
      const reason = SHELL_SCRIPT.test(file) ? shellReason(text, roots, cwd) : codeReason(text, roots, cwd, /.py$/i.test(file));
      if (reason) return '脚本 ' + path + ' 里：' + reason;
    }
  }
  return '';
}
