// Claude Code 和 Codex 使用 tool_name、tool_input、cwd；Antigravity 使用 toolCall{name,args}、cwd。
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { absolute } from './rules.mjs';

/** 本文件在 <根>/.claude/hooks/ 下，根目录不依赖会话的启动位置。 */
export const HOOK_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isFile = (path) => statSync(path, { throwIfNoEntry: false })?.isFile() === true;

export function hookCwd(input, root = HOOK_ROOT) {
  return typeof input?.cwd === 'string' && input.cwd ? input.cwd : root;
}

/**
 * 要护住的项目根目录：自己；在单独工作区里（.git 是文件，指向主项目 .git/worktrees/<名字>）时再加上主项目，
 * 主项目下的真实数据一样不能碰。子模块的 .git 也是文件，但没有 commondir，不算工作区。
 */
export function projectRoots(root) {
  const dotGit = join(root, '.git');
  if (!isFile(dotGit)) return [root];
  const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
  if (!gitdir) return [root];
  const worktreeGit = resolve(root, gitdir[1].trim());
  const commondir = join(worktreeGit, 'commondir');
  if (!isFile(commondir)) return [root];
  return [root, dirname(resolve(worktreeGit, readFileSync(commondir, 'utf8').trim()))];
}

/**
 * Codex 的 apply_patch 补丁文字（实测：tool_input.command 是 "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch"）：
 * 逐个文件取出路径、动作、改名后的路径和加减了几行。
 */
export function parsePatch(text) {
  if (typeof text !== 'string') return [];
  const files = [];
  for (const line of text.split(/\r?\n/)) {
    const head = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    const current = files.at(-1);
    if (head) files.push({ action: head[1].toLowerCase(), path: head[2].trim(), added: 0, removed: 0 });
    else if (move && current) current.moveTo = move[1].trim();
    else if (current && line.startsWith('+')) current.added += 1;
    else if (current && line.startsWith('-')) current.removed += 1;
  }
  return files;
}

/** Claude Code 的文件类工具：file_path、notebook_path、path；Glob 的 pattern 本身就是路径，取第一个通配符之前的部分 */
function claudePaths(tool, args, cwd) {
  const paths = [args.file_path, args.notebook_path, args.path];
  if (tool === 'Glob' && typeof args.pattern === 'string') {
    const base = typeof args.path === 'string' ? absolute(cwd, args.path) : cwd;
    paths.push(absolute(base, args.pattern.split(/[*?[{]/)[0] || '.'));
  }
  return paths;
}

const CLAUDE_WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
/** 内置浏览器（含远程设备上的）和 Chrome 扩展的工具：批量动作、执行脚本的网址和脚本文字藏在参数里面 */
const BROWSER_TOOL = /^mcp__.*(?:browser|chrome)/i;
/** 参数里所有的字符串，一层层往里找 */
const stringsIn = (value) =>
  typeof value === 'string' ? [value]
    : Array.isArray(value) ? value.flatMap(stringsIn)
      : isObject(value) ? Object.values(value).flatMap(stringsIn) : [];

/**
 * 一次工具调用要查的东西：command 命令文字；paths 碰到的路径（读写都算）；
 * writes 其中要写入的路径；urls 浏览器要打开的地址和要在页面里跑的脚本（只查连没连正式实例）。
 */
function claudeOrCodexCall(input, root) {
  const tool = input.tool_name;
  const args = isObject(input.tool_input) ? input.tool_input : {};
  const cwd = hookCwd(input, root);
  const call = { antigravity: false, cwd, command: '', paths: [], writes: [], urls: [] };
  // Codex 的命令行不论实际是哪种 shell，tool_name 都是 Bash
  if (tool === 'Bash' || tool === 'PowerShell') return { ...call, command: args.command };
  if (tool === 'apply_patch') {
    const paths = parsePatch(args.command).flatMap((file) => [file.path, file.moveTo]);
    return { ...call, paths, writes: paths };
  }
  // 内置浏览器、Chrome 扩展：打开网址、批量动作里的每一步、执行的脚本，参数里的字符串都查；WebFetch 取 url
  if (BROWSER_TOOL.test(tool)) return { ...call, urls: stringsIn(args) };
  if (typeof args.url === 'string') return { ...call, urls: [args.url] };
  const writes = CLAUDE_WRITE_TOOLS.includes(tool) ? [args.file_path, args.notebook_path] : [];
  return { ...call, paths: claudePaths(tool, args, cwd), writes };
}

/** Antigravity：run_command 判 CommandLine 和 Cwd，其余工具判路径，run_workflow 另判 Script；按工具名认写入。 */
function antigravityCall(input, root) {
  const { name, args: rawArgs } = input.toolCall;
  const args = isObject(rawArgs) ? rawArgs : {};
  const cwd = hookCwd(input, root);
  const call = { antigravity: true, cwd, command: '', paths: [], writes: [], urls: [] };
  const valuesOf = (key) => Object.entries(args).filter(([k]) => key.test(k)).map(([, value]) => value);
  if (name === 'run_command') return { ...call, command: args.CommandLine, paths: valuesOf(/^cwd$/i) };
  const paths = valuesOf(/(?:^cwd|path)$/i);
  const writes = /write|edit|replace|delete|move|create/i.test(name) ? paths : [];
  const command = name === 'run_workflow' ? args.Script : '';
  return { ...call, paths, writes, urls: valuesOf(/url$/i), command };
}

/** 认出是哪家的输入；认不出返回 null */
export function readToolCall(input, root = HOOK_ROOT) {
  if (!isObject(input)) return null;
  if (isObject(input.toolCall) && typeof input.toolCall.name === 'string') return antigravityCall(input, root);
  if (typeof input.tool_name === 'string') return claudeOrCodexCall(input, root);
  return null;
}

/** 读完标准输入并解析成 JSON */
export async function readStdinJson() {
  let raw = '';
  // 按 UTF-8 解码整段流：一个汉字的几个字节可能分在两块里
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  return JSON.parse(raw || '{}');
}
