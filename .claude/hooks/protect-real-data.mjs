// 三家共用的 PreToolUse 挡板。认不出的输入或钩子自身出错时放行。
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { HOOK_ROOT, projectRoots, readStdinJson, readToolCall } from './hook-input.mjs';
import { askReason, checkCommand, checkPath, normRoot } from './rules.mjs';

/** 判一次：{ decision: 'deny' | 'ask', reason }，放行是 null。roots 是要护住的项目根目录（未统一写法）。 */
export function judge(call, roots) {
  const normRoots = roots.map(normRoot);
  const denied = checkCommand(call.command, normRoots, call.cwd)
    || call.paths.map((path) => checkPath(path, normRoots, call.cwd)).find(Boolean);
  if (denied) return { decision: 'deny', reason: denied };
  const ask = call.antigravity && askReason(call.command, roots[0]);
  return ask ? { decision: 'ask', reason: ask } : null;
}

/**
 * 按各家的格式回话；放行回空串（三家都实测过：什么都不输出就照常执行）。
 * Claude Code 和 Codex 只回 deny：先问人的命令由 Claude 的 permissions.ask、Codex 的 .codex/rules 管
 * （Codex 不支持钩子回 ask，回了等于没拦）；Antigravity 由这里回 ask。
 */
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
    const verdict = call && judge(call, roots);
    if (verdict) process.stdout.write(JSON.stringify(reply(call.antigravity, verdict)));
  } catch {
    // 钩子自己出错时放行，不能因为挡板坏了把正常工作卡死。
  }
}
