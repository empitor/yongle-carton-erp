// 命令碰到真实业务数据目录（data/、backups/）的判断（rules.mjs 的 checkCommand 调用）：点名写出来的、删搬列命令裸写目录名的、
// 会连带整个目录的（根目录、上级、通配、git clean -x、git stash -a、find -delete、管道删除）。
// 同一条命令里先进目录的（cd src && ls data）跟着换当前目录；Join-Path 拼在临时目录下的 data\… 不算。
import { existsSync } from 'node:fs';
import {
  DATA_DIRS, DATA_RULE, absolute, dataReason, norm, normRoot, pathForms, protectedDataDir, resolveArg, segmentMatches, sweepsData,
} from './paths.mjs';
import { commandSteps, programOf, shellTokens, unquote, writableText } from './shell-words.mjs';
import { expandText, unresolved, variableValues } from './variables.mjs';

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
/** 相对路径：data/…、./data/…、backups\…；前面必须是命令行分隔，src/data/ 这类不算 */
const RELATIVE = /(?:^|[\s"'=(;|&<>,])(?:\.\/)?(data|backups)\//g;
/** 进入目录：cd data、Set-Location backups */
const ENTER = /(?:^|[\s;&|(])(?:cd|pushd|set-location|sl)\s+["']?(?:\.\/)?(data|backups)["']?(?=$|[\s;&|)])/;
const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);
/** 回到上一个目录：目录栈没跟着记，当作回到原目录 */
const POP = new Set(['popd', 'pop-location']);
/** cd 的目标认不出（cd -、去掉认得的 $PWD/~ 开头后还有变量）：当作回到原目录 */
const unknownTarget = (target) =>
  target === '-' ||
  /[$%`]/.test(target.replace(/^(?:\$\{?pwd\}?|\$pwd\.path|~|\$\{?home\}?|\$env:(?:userprofile|home)|%userprofile%)(?=$|[\\/])/i, ''));
const EXCLUDE = /^-{1,2}exclude(?:-from)?$/i;
/** PowerShell 带值的筛选开关：后面那个词是筛选条件，不是路径 */
const FILTER_OPTION = /^-(?:filter|include|depth|attributes)$/i;
const OPTION_WORD = /^-|^\/[a-z]+(?::\S*)?$/i;

/**
 * 命令拆成段，每段带上它跑时的当前目录：cd、Set-Location 之后用 && 接着的段换到新目录；用 ; 或换行接着的，
 * 新目录真存在才换（cd 失败时 ; 后面照样在原目录跑）。管道、||、& 和括号之后回到原目录；
 * cd -、popd、Pop-Location、目标是认不出的变量（$OLDPWD、$P、%CD%）的，也回到原目录。
 */
function stepsWithDirs(cased, cwd) {
  let here = cwd;
  let entered = true;
  let unknownDir = false;
  return commandSteps(cased).map(({ words, before }) => {
    const keep = before === '&&' || (/^[;\n]+$/.test(before) && entered);
    if (!keep) {
      here = cwd;
      entered = true;
      unknownDir = false;
    }
    const lower = words.map((word) => word.toLowerCase());
    const step = { words: lower, cased: words, cwd: here, before, unknownDir };
    const { name, rest } = programOf(lower);
    const target = CD.has(name) ? rest.find((word) => word === '-' || !word.startsWith('-')) : undefined;
    if (POP.has(name) || (target !== undefined && unknownTarget(target))) {
      // 回到哪里认不出：按原目录判（R5-1），另记下“当前目录认不出”，后面删、搬相对路径的要拦
      here = cwd;
      entered = true;
      unknownDir = target !== undefined && target !== '-';
    } else if (target) {
      here = resolveArg(here, target);
      entered = existsSync(here);
    }
    return step;
  });
}

const inside = (abs, roots) => roots.some((root) => abs === root || abs.startsWith(root + '/'));
/** 不在任何项目根目录里、也不是它们上级的绝对路径 */
const outside = (abs, roots) => !inside(abs, roots) && !sweepsData(abs, roots);

/**
 * 同一条命令里给变量赋的值（每一处 $x = …）；用 Set-Variable、New-Variable、+=、foreach、[ref] 改过的认不出，返回 null。
 */
function assignmentsOf(variable, text) {
  const changed = new RegExp(
    '(?:set-variable|new-variable|\\bsv|\\bnv)\\s+(?:-name\\s+)?' + variable + '\\b|\\$' + variable + '\\s*[-+*/.]=' +
      '|foreach\\s*\\(\\s*\\$' + variable + '\\b|\\[ref\\]\\s*\\$' + variable + '\\b',
  );
  if (changed.test(text)) return null;
  const values = [...text.matchAll(new RegExp('\\$' + variable + '\\s*=(?!=)\\s*([^;\\n]+)', 'g'))]
    .map((m) => m[1].trim().replace(/^\(|\)$/g, ''));
  return values.length ? values : null;
}

/**
 * Join-Path 的父目录是不是明确在项目外：$env:TEMP、[IO.Path]::GetTempPath()、项目外的写死路径，
 * 或者同一条命令里每一处都赋成这几种的变量（最多追三层）。认不出的都不算。
 */
function safeParent(parent, text, roots, cwd, depth = 0) {
  const word = unquote(parent.trim()).replace(/^\((.*)\)$/, '$1');
  if (/^\$env:(?:temp|tmp)(?=$|\/)/.test(word) || /^\[io\.path\]::gettemppath\(\)/.test(word)) return true;
  if (/^[a-z]:\//.test(word)) return pathForms(absolute(cwd, word)).every((abs) => outside(abs, roots));
  const variable = /^\$(\w+)$/.exec(word)?.[1];
  if (!variable || depth > 2) return false;
  const values = assignmentsOf(variable, text);
  return Boolean(values) && values.every((assigned) => {
    const joined = /^join-path\s+(?:-path\s+)?((["'])[^"']*\2|\S+)/.exec(assigned);
    return safeParent(joined ? joined[1] : assigned, text, roots, cwd, depth + 1);
  });
}

/** Join-Path 的父目录写死了的（路径、.、$PWD、~，或同一条命令里每一处都赋成同一个写死路径的变量）：那个路径，认不出返回 '' */
function knownParent(parent, text) {
  const variable = /^\$(\w+)$/.exec(parent)?.[1];
  if (variable && !['pwd', 'home'].includes(variable)) {
    const values = [...new Set((assignmentsOf(variable, text) ?? []).map(unquote))];
    return values.length === 1 && !/[$%`(]/.test(values[0]) ? values[0] : '';
  }
  return /[$%`(]/.test(parent.replace(/^(?:\$pwd|\$home|~)(?=$|\/)/, '')) ? '' : parent;
}

/** Join-Path 父目录写死时，拼出来的路径落在真实数据目录里的：目录名 */
function joinedDir(rest, text, roots, cwd) {
  const [parent, child] = argumentsOf(rest);
  const base = parent && child ? knownParent(parent, text) : '';
  if (!base) return '';
  return pathForms(resolveArg(cwd, base + '/' + child)).map((abs) => protectedDataDir(abs, roots)).find(Boolean) ?? '';
}

/** 相对路径写法 data/… 的第一处（Join-Path 拼在明确的项目外目录下的不算） */
function relativeDir(text, roots, cwd) {
  for (const m of text.matchAll(RELATIVE)) {
    const before = text.slice(0, m.index + m[0].lastIndexOf(m[1])).replace(/\.\/$/, '');
    const join = /join-path\s+(?:-path\s+)?((["'])[^"']*\2|\S+)\s+(?:-childpath\s+)?["']?$/.exec(before);
    if (!join || !safeParent(join[1], text, roots, cwd)) return m[1];
  }
  return '';
}

/** 删搬列这类命令的参数里按当前目录解析后落在真实数据目录的；排除用的（robocopy /XD a b、--exclude data）、筛选条件不算 */
function dirArgument(rest, roots, cwd) {
  const inData = (path) => pathForms(resolveArg(cwd, path)).map((abs) => protectedDataDir(abs, roots)).find(Boolean);
  let skip = 0;
  for (const word of rest) {
    // robocopy /XD、/XF：到下一个开关为止都是排除的；--exclude、-Exclude、-Filter 只管后面一个
    if (/^\/x[df]$/i.test(word)) skip = Infinity;
    else if (EXCLUDE.test(word) || FILTER_OPTION.test(word)) skip = 1;
    else if (OPTION_WORD.test(word)) {
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

/** 命令文字里点名碰到真实数据目录：相对路径、进目录、代码里裸写、项目根目录（各个）的绝对路径、../ 绕回来的、删搬列命令裸写的 */
function dataDirIn(text, steps, roots, cwd) {
  const hit = relativeDir(text, roots, cwd) || ENTER.exec(text)?.[1] || CODE_ON_DIR.exec(text)?.[2];
  if (hit) return hit;
  for (const root of roots) {
    const inRoot = new RegExp(
      root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/(data|backups)(?=$|[/\\s"\';|&)])',
    ).exec(text);
    if (inRoot) return inRoot[1];
  }
  // 工作区可以用 ../主项目/data/… 访问真实目录，也按路径解析。
  for (const token of shellTokens(text)) {
    const path = unquote(unquote(token).replace(/^[\w-]+=/, ''));
    if (!/^(?:\.\.?\/)+/.test(path)) continue;
    const dir = protectedDataDir(normRoot(absolute(cwd, path)), roots);
    if (dir) return dir;
  }
  for (const step of steps) {
    const { name, rest, sub } = programOf(step.words);
    const dir = name === 'join-path' ? joinedDir(rest, text, roots, step.cwd)
      : DIR_PROGRAMS.has(name) || GIT_DIR_COMMANDS.has(sub) ? dirArgument(rest, roots, step.cwd) : '';
    if (dir) return dir;
  }
  return '';
}

/** 删、搬、复制、打包的程序：参数是根目录、它的上级或通配写法时会连带 data、backups（复制和搬只看来源，最后一个是目标） */
const SWEEP_DELETE = new Set([
  'rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'rimraf', 'del-cli', 'trash',
  'ren', 'rename', 'rename-item', 'rni', 'tar', 'zip', '7z', 'compress-archive',
]);
const SWEEP_COPY = new Set(['cp', 'copy', 'copy-item', 'cpi', 'xcopy', 'robocopy', 'rsync', 'mv', 'move', 'move-item', 'mi']);
/** 管道前头列出文件的程序（Get-ChildItem | Remove-Item、ls | xargs rm、find | xargs rm） */
const LISTERS = new Set(['ls', 'dir', 'gci', 'get-childitem', 'get-item', 'gi', 'find', 'fd']);
const SWEEP_REASON =
  '会连带真实业务数据目录 data/、backups/ 一起删掉、搬走或复制出去（项目根目录、它的上级或通配写法）' + DATA_RULE +
  '只点名要动的文件或目录；不以项目根目录为来源复制（AGENTS.md“常用命令”）。';
const GIT_SWEEP_REASON =
  'git clean -x/-X 和 git stash -a/--all 会连被忽略的 data/、backups/ 一起删掉' + DATA_RULE +
  '清没跟踪的文件用 git clean -fd（不带 x），先 git clean -n 看要删哪些。';

/** 一段的参数（去掉开关，-Path:x、--file=x 取值；排除用的、筛选条件、-Destination 指的目标不算） */
function argumentsOf(rest) {
  const out = [];
  let skip = 0;
  for (const word of rest) {
    if (/^\/x[df]$/i.test(word)) skip = Infinity;
    else if (EXCLUDE.test(word) || FILTER_OPTION.test(word) || /^-destination(?:path)?$/i.test(word)) skip = 1;
    else if (OPTION_WORD.test(word)) {
      skip = 0;
      const option = /^-{1,2}([\w-]+)[=:](.+)$/.exec(word);
      if (option && !/^(?:exclude(?:-from)?|destination(?:path)?|filter|include)$/i.test(option[1])) out.push(option[2]);
    } else if (skip) skip -= 1;
    else out.push(word);
  }
  return out;
}

/** tar 的参数连同它所在的目录：-C 目录、--directory 之后的参数按那个目录解析（-C 区分大小写，-c 是打包） */
function tarArguments(cased, cwd) {
  const groups = [{ base: cwd, words: [] }];
  for (let i = 0; i < cased.length; i++) {
    const word = cased[i];
    const directory = /^--directory=(.+)$/i.exec(word)?.[1] ?? (word === '-C' || /^--directory$/i.test(word) ? cased[++i] : undefined);
    if (directory === undefined) groups.at(-1).words.push(word.toLowerCase());
    else groups.push({ base: resolveArg(groups.at(-1).base, directory.toLowerCase()), words: [] });
  }
  return groups.flatMap(({ base, words }) => argumentsOf(words).map((arg) => ({ arg, base })));
}

/** git clean 带 x（不是只看的 -n）：目录是根目录、它的上级或在 data 里；git stash 带 -a/--all：目录在项目里或是上级（整个仓库收） */
function gitSweeps({ sub, subArgs, gitDir }, roots, cwd) {
  const flags = subArgs.filter((word) => /^-[^-]/.test(word)).join('');
  const clean = sub === 'clean' && /x/i.test(flags) && !/n/i.test(flags) && !subArgs.includes('--dry-run');
  const stash = sub === 'stash' && (/a/i.test(flags) || subArgs.includes('--all'));
  if (!clean && !stash) return false;
  const dir = resolveArg(cwd, gitDir || '.');
  const swept = (abs) => sweepsData(abs, roots) || Boolean(protectedDataDir(abs, roots)) || (stash && inside(abs, roots));
  if (pathForms(dir).some(swept)) return true;
  return clean && subArgs.filter((word) => !word.startsWith('-')).some((word) =>
    word.startsWith(':/') || pathForms(resolveArg(dir, word)).some((abs) => sweepsData(abs, roots)));
}

/** find 的起点（选项前面的词，不写是当前目录） */
function findStarts(rest) {
  const option = rest.findIndex((word) => /^[-!\\(]/.test(word));
  const starts = option < 0 ? rest : rest.slice(0, option);
  return starts.length ? starts : ['.'];
}

const sweeping = (words, roots, cwd) =>
  words.some((word) => pathForms(resolveArg(cwd, word)).some((abs) => sweepsData(abs, roots) || protectedDataDir(abs, roots)));

/**
 * 命令里的管道：按真正的 | 分隔符（拆段时认出来的，引号里的 | 不算）把段连成一串；ForEach-Object { … } 花括号里的段
 * 算在这串管道里。只有一段的不算管道。
 */
function pipelines(steps) {
  const out = [];
  for (const step of steps) {
    const current = out.at(-1);
    const piped = step.before === '|' || (current?.length > 1 && /^[{}()]+$/.test(step.before));
    if (piped && current) current.push(step);
    else out.push([step]);
  }
  return out.filter((line) => line.length > 1);
}

/** 管道后头有删除程序的，前头那段的程序名和起点 */
function deletingPipelines(steps, deleters) {
  return pipelines(steps).flatMap(([head, ...tail]) => {
    if (!tail.some((step) => deleters.has(programOf(step.words).name))) return [];
    const { name, rest } = programOf(head.words);
    const starts = name === 'find' || name === 'fd' ? findStarts(rest) : argumentsOf(rest);
    return [{ name, starts: starts.length ? starts : ['.'], cwd: head.cwd }];
  });
}

/** 管道里前头列文件、后头删（Get-ChildItem -Recurse | Remove-Item、ls | xargs rm）：列的起点盖住 data、backups 就拦 */
const pipelineSweeps = (steps, roots) =>
  deletingPipelines(steps, SWEEP_DELETE).some(({ name, starts, cwd }) => LISTERS.has(name) && sweeping(starts, roots, cwd));

/** 一条命令会不会连带整个 data、backups 一起删、搬、复制：拦下的理由，不会返回空串 */
function sweepReason(text, steps, roots, cwd) {
  for (const step of steps) {
    const program = programOf(step.words);
    if (program.name === 'git' && gitSweeps(program, roots, step.cwd)) return GIT_SWEEP_REASON;
    const finds = program.name === 'find' && /\s-delete\b|\s-(?:exec|execdir|ok)\s+(?:\S*\/)?(?:rm|rmdir|unlink|shred|mv)\b/.test(text);
    if (finds && sweeping(findStarts(program.rest), roots, step.cwd)) return SWEEP_REASON;
    if (program.name === 'tar') {
      const at = step.words.indexOf(program.word);
      const swept = tarArguments(step.cased.slice(at + 1), step.cwd).some(({ arg, base }) => sweeping([arg], roots, base));
      if (swept) return SWEEP_REASON;
      continue;
    }
    if (!SWEEP_DELETE.has(program.name) && !SWEEP_COPY.has(program.name)) continue;
    const args = argumentsOf(program.rest);
    const destination = program.rest.some((word) => /^-destination(?:path)?(?:[=:]|$)/i.test(word));
    const sources = SWEEP_COPY.has(program.name) && !destination && args.length > 1 ? args.slice(0, -1) : args;
    if (sources.some((word) => pathForms(resolveArg(step.cwd, word)).some((abs) => sweepsData(abs, roots)))) return SWEEP_REASON;
  }
  return pipelineSweeps(steps, roots) ? SWEEP_REASON : '';
}

/** 命令行碰到真实数据目录：拦下的理由，不碰返回空串 */
// shell 的花括号展开（rm -rf {data,tmp}）先展开成几个词，花括号在拆段时会被当成分隔
const braces = (text) => text.replace(/([^\s{}]*)\{([^{}\s]*,[^{}\s]*)\}([^\s{}]*)/g, (_, head, list, tail) =>
  list.split(',').map((item) => head + item + tail).join(' '));
// $(pwd)、$(Get-Location)、${PWD}、${HOME} 换成 $PWD、$HOME：括号在拆段时会被当成分隔
const pwd = (text) =>
  text.replace(/\$\((?:pwd|get-location)\)/gi, '$$PWD').replace(/\$\{(pwd|home)\}/gi, (_, name) => '$' + name);

/** 一份命令文字（norm 过的小写和不转小写的两份）按点名、连带整个目录的规矩判 */
function knownReason(text, cased, roots, cwd) {
  const steps = stepsWithDirs(braces(cased), cwd);
  const dir = dataDirIn(text, steps, roots, cwd);
  if (dir) return dataReason(dir);
  return sweepReason(braces(text), steps, roots, cwd);
}

/** 删除、搬走的程序：目标认不出（变量没赋值、命令替换、子表达式）就拦 */
const DELETE_MOVE = new Set([
  'rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'rimraf', 'del-cli', 'trash', 'unlink', 'shred',
  'mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rni',
]);
const UNKNOWN_REASON =
  '删除、搬走的目标认不出（变量不是在同一条命令里赋的值、命令替换或子表达式算出来的路径、cd 到认不出的目录后的相对路径），' +
  '挡板判断不了会不会碰到真实数据（AGENTS.md“碰不得的”）。写成字面路径，或在同一条命令里先赋值再用' +
  '（如 T="$(mktemp -d)"; …; rm -rf "$T"，$t = Join-Path $env:TEMP x; Remove-Item -Recurse $t）。';
/** 管道里交过来的那一项（ForEach-Object { Remove-Item $_ }）：按管道前头列文件的那段判 */
const PIPED_ITEM = /^\$(?:_|psitem)(?:$|\.)/;

/** 删除、搬走的目标（展开过变量的命令）里有认不出的：拦下的理由 */
function unknownTargetReason(steps, text) {
  for (const [i, step] of steps.entries()) {
    const program = programOf(step.words);
    const gitTargets = program.name === 'git' && ['rm', 'mv', 'clean'].includes(program.sub);
    const finds = program.name === 'find' && /\s-delete\b|\s-(?:exec|execdir|ok)\s+(?:\S*\/)?(?:rm|rmdir|unlink|shred|mv)\b/.test(text);
    if (!DELETE_MOVE.has(program.name) && !gitTargets && !finds) continue;
    const args = finds ? findStarts(program.rest) : argumentsOf(gitTargets ? program.subArgs : program.rest);
    const targets = args.filter((word) => !PIPED_ITEM.test(word));
    if (targets.some(unresolved)) return UNKNOWN_REASON;
    if (step.unknownDir && targets.some((word) => !/^(?:[a-z]:\/|\/|~)/.test(word))) return UNKNOWN_REASON;
    // 删除程序后面没写路径：管道交过来的看前头；括号里算出来的（Remove-Item (…)）只认父目录写死的 Join-Path
    const next = steps[i + 1];
    const computed = !args.length && !gitTargets && next && next.before.endsWith('(');
    if (computed && (programOf(next.words).name !== 'join-path' || next.words.some(unresolved))) return UNKNOWN_REASON;
  }
  // 管道后头删、前头不是列文件的程序，或者列文件的起点认不出
  const piped = deletingPipelines(steps, DELETE_MOVE).some(({ name, starts }) => !LISTERS.has(name) || starts.some(unresolved));
  return piped ? UNKNOWN_REASON : '';
}

/**
 * 命令行碰到真实数据目录：拦下的理由，不碰返回空串。同一条命令里赋的变量、认得的环境变量先展开
 * （几个值就判几份，原样的也判），展开完删除、搬走的目标还认不出的也拦。
 */
export function dataCommandReason(command, roots, cwd) {
  const text = pwd(norm(command));
  const cased = pwd(norm(command, true));
  const values = variableValues(text, cwd, cased);
  const lowers = [text, ...expandText(text, values).map((variant) => variant.toLowerCase()).filter((variant) => variant !== text)];
  const caseds = [cased, ...expandText(cased, values).filter((variant) => variant !== cased)];
  for (const [k, lower] of lowers.entries()) {
    const reason = knownReason(lower, caseds[k] ?? lower, roots, cwd);
    if (reason) return reason;
  }
  // 认删除目标只看真正会跑的：写进文件的 heredoc、here-string 正文（写笔记、写脚本时常提到 rm "$x"）不算
  const runnable = writableText(command);
  const runText = pwd(norm(runnable));
  const runCased = pwd(norm(runnable, true));
  const runValues = variableValues(runText, cwd, runCased);
  const runLower = expandText(runText, runValues).at(-1).toLowerCase();
  return unknownTargetReason(stepsWithDirs(braces(expandText(runCased, runValues).at(-1)), cwd), braces(runLower));
}

/**
 * Glob 工具的通配写法列得出 data、backups 里的文件名：开头只有 ** 的、目录那一段配得上 data、backups 的
 * （**\/data/*.sqlite、d*\/*）。目录段只写 * 的不算（*\/x.json 太常用，留作已知没拦的）。
 */
export function globReason(base, pattern, roots, cwd) {
  if (typeof pattern !== 'string') return '';
  const segments = norm(pattern).split('/').filter(Boolean);
  const k = segments.findIndex((segment) => segment !== '**');
  if (k < 0 || k === segments.length - 1 || segments[k] === '*') return '';
  const dir = DATA_DIRS.find((name) => segmentMatches(segments[k], name));
  if (!dir) return '';
  const bases = pathForms(absolute(cwd, typeof base === 'string' && base ? base : '.'));
  const reaches = bases.some((abs) =>
    k === 0 ? roots.includes(abs) : roots.some((root) => root === abs || root.startsWith(abs + '/')));
  return reaches ? dataReason(dir) : '';
}
