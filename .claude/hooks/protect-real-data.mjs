// 三家共用的 PreToolUse 挡板。认不出的输入或钩子自身出错时放行。拦什么、为什么写在 rules.mjs 和 data-commands.mjs，
// 被拦时的提示里有原因和改法。
//
// 三家怎么接（工具执行前都调本文件，取参数的写法在 hook-input.mjs）：
// - Claude Code：.claude/settings.json，新会话生效。Bash、PowerShell 取 tool_input.command；Read、Edit、Write、MultiEdit、
//   NotebookEdit、Glob、Grep 取 tool_input 的 file_path、notebook_path、path（Glob 还查 pattern 第一个通配符前的路径，
//   以及通配写法列不列得出 data、backups 里的文件名）；
//   WebFetch 取 url；内置浏览器（含远程设备上的）的 navigate、preview_start、browser_batch、javascript_tool 和 Chrome 扩展的
//   navigate、browser_batch、javascript_tool 取参数里的字符串（批量动作里每一步的网址、执行的脚本；找元素的 query 不算），
//   只查连没连正式实例。
// - Codex：.codex/hooks.json，项目要受信任，钩子首次使用或定义改动后由用户用 /hooks 信任。终端按 Bash 上报（本机跑 PowerShell），
//   取 tool_input.command；apply_patch 从同一字段的补丁头查 Add File、Update File、Delete File、Move to 的路径。
// - Antigravity：.agents/hooks.json（matcher 为 *），新会话生效。run_command 取 toolCall.args.CommandLine，另查 Cwd；别的工具查参数名以
//   Path 结尾的值和 Cwd、TargetFile、SearchDirectory（大小写不限；参数名没有实测样本），工具名含 write、edit、replace、delete、
//   move、create 的算写入；参数名以 Url 结尾的按地址查；
//   run_workflow 还按命令文字查 Script。
// 回答：Claude Code 和 Codex 回 hookSpecificOutput.permissionDecision（deny / ask），Antigravity 回顶层 decision。允许的和认不出的都不输出。
// “先问”只回给 Claude Code（环境里有 CLAUDE_PROJECT_DIR：settings.json 里的命令就靠它找到本文件）。Codex 不支持钩子回 ask，
// Antigravity 认不认 ask 没有实测样本，这两家判出“先问”的一律改成拦下并说明（deliverable）；Codex 自己的前缀规则会问的
// （整条命令就是一条、开头正好是 .codex/rules 里的前缀）不出声，让 Codex 问。
// cwd 缺失或为空时按项目根目录解析相对路径；在 Git 单独工作区里经 Git 元数据找到主项目，两边的真实数据目录都护住。
// 三家的命令行还从命令文字里认出写到的路径（重定向、Set-Content、cp 的目标等），和文件工具的写入一样判；跑脚本文件的还扫脚本内容（script-scan.mjs）。
// 先问人的命令前缀：Claude Code 是 .claude/settings.json 的 permissions.ask；本挡板读同一份清单（忽略大小写，认前置环境变量赋值、
// 括号或花括号包住的、用 & 和完整路径调用的、子命令前带开关的 git -C . push、powershell -c "…" 里的），三家都判（askReason），
// 前缀清单认不出的变形写法也就问到了；Codex 是 .codex/rules/ask-before.rules（改了重启 Codex）。
// tests/checks/claude-hooks.test.mjs 核对清单和 Codex 规则一致。停本机正式实例、连真实模型的脚本另由本挡板判（rules.mjs 的 commandAskReason）。
// 写完文件后的提醒另在 file-size-reminder.mjs（Antigravity 的 PostToolUse 回不了文字，接不了）。
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { globReason } from './data-commands.mjs';
import { HOOK_ROOT, projectRoots, readStdinJson, readToolCall } from './hook-input.mjs';
import { longPath, normRoot } from './paths.mjs';
import { scriptReason } from './script-scan.mjs';
import {
  askReason,
  checkCommand,
  checkConfigReason,
  checkPath,
  commandAskReason,
  commandInstanceReason,
  lockedReason,
  officialInstanceReason,
  readAskRules,
} from './rules.mjs';
import { commandSteps, commandWrites } from './shell-words.mjs';

const first = (items, check) => items.map(check).find(Boolean) || '';

/**
 * 判一次：{ decision: 'deny' | 'ask', reason }，放行是 null。roots 是要护住的项目根目录（未统一写法），
 * 带 8.3 短名的根目录也按长名护住；命令行会写到的路径和文件工具的写入一样判。
 */
export function judge(call, roots) {
  const normRoots = [...new Set(roots.flatMap((root) => [root, longPath(root)]).map(normRoot))];
  const writes = [...call.writes, ...commandWrites(call.command)];
  const denied = checkCommand(call.command, normRoots, call.cwd)
    || scriptReason(call.command, normRoots, roots, call.cwd)
    || first(call.paths, (path) => checkPath(path, normRoots, call.cwd))
    || first(call.globs ?? [], ({ base, pattern }) => globReason(base, pattern, normRoots, call.cwd))
    || first(writes, (path) => lockedReason(path, normRoots, call.cwd));
  if (denied) return { decision: 'deny', reason: denied };
  // 命令行只看真的会去连、去启停的那一段；Antigravity 的 run_workflow 脚本（代码）、浏览器地址照旧看全文
  const ask = (call.scriptText ? officialInstanceReason(call.command) : commandInstanceReason(call.command, call.cwd, call.powershell))
    || first(call.urls, officialInstanceReason)
    || first(writes, (path) => checkConfigReason(path, normRoots, call.cwd))
    || askReason(call.command, roots[0])
    || commandAskReason(call.command);
  return ask ? { decision: 'ask', reason: ask } : null;
}

const CODEX_HINT =
  '（Codex 下钩子回不了“先问”，所以直接拦下：换成 .codex/rules/ask-before.rules 认得的写法让 Codex 问用户，或请用户自己做，或到 Claude Code 里做。）';
const ANTIGRAVITY_HINT = '（Antigravity 认不认“先问”还没有实测样本，所以直接拦下：请用户自己做，或到 Claude Code 里做。）';

/** Codex 自己会问的：整条命令就是一条，程序名（不带目录，可带 .cmd、.exe）和后面的词开头正好是 .codex/rules 里的前缀 */
function codexPrompts(command, root) {
  const steps = typeof command === 'string' ? commandSteps(command.trim()) : [];
  if (steps.length !== 1) return false;
  const [program, ...rest] = steps[0].words;
  return readAskRules(root).some(({ prefix: [name, ...args] }) =>
    [name, name + '.cmd', name + '.exe'].includes(program) && args.every((part, i) => rest[i] === part));
}

/**
 * 回给工具的判断：“先问”只回给 Claude Code。Codex（没有 CLAUDE_PROJECT_DIR 的）和 Antigravity 判出“先问”的改成拦下并说明；
 * Codex 自己的前缀规则会问的不出声。claude 是这次是不是 Claude Code 调的，root 读审批清单用。
 */
export function deliverable(verdict, call, { claude, root }) {
  if (verdict?.decision !== 'ask' || (claude && !call.antigravity)) return verdict;
  if (!call.antigravity && codexPrompts(call.command, root)) return null;
  return { decision: 'deny', reason: verdict.reason + (call.antigravity ? ANTIGRAVITY_HINT : CODEX_HINT) };
}

/** 按各家的格式回话；放行回空串（三家都实测过：什么都不输出就照常执行）。 */
function reply(antigravity, verdict) {
  if (antigravity) return verdict;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: verdict.decision,
      permissionDecisionReason: verdict.reason,
    },
  };
}

if (import.meta.main) {
  try {
    const call = readToolCall(await readStdinJson());
    const roots = projectRoots(HOOK_ROOT);
    // 从目录联接启动时，工具给的路径也可能使用联接目录名。
    const launchRoot = resolve(dirname(process.argv[1]), '../..');
    if (normRoot(launchRoot) !== normRoot(HOOK_ROOT) && normRoot(realpathSync(launchRoot)) === normRoot(HOOK_ROOT))
      roots.push(launchRoot);
    const claude = Boolean(process.env.CLAUDE_PROJECT_DIR);
    const verdict = call && deliverable(judge(call, roots), call, { claude, root: roots[0] });
    if (verdict) process.stdout.write(JSON.stringify(reply(call.antigravity, verdict)));
  } catch {
    // 钩子自己出错时放行，不能因为挡板坏了把正常工作卡死。
  }
}
