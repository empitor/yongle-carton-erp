#!/usr/bin/env node
// 写完文件后的提醒（Claude Code 的 Write、Edit、MultiEdit，Codex 的 apply_patch；Antigravity 的 PostToolUse 不能回文字，接不了）：
// 代码、样式、测试文件被写长了，超过 300 行就当场提醒（只提醒，不拦）。
// 规矩在 AGENTS.md“文件怎么分”：尽量 100 到 300 行，500 行封顶。真正守住它的是测试，这里只是发现得更早。
import { readFileSync } from 'node:fs';
import { relative, extname } from 'node:path';
import { HOOK_ROOT, hookCwd, parsePatch, readStdinJson } from './hook-input.mjs';
import { absolute } from './rules.mjs';

const SOFT = 300;
const HARD = 500;
const DIRS = ['server', 'shared', 'src', 'tests', 'scripts'];
const EXTS = ['.ts', '.tsx', '.mts', '.mjs', '.js', '.css'];
// 认可的特例：按表逐条罗列的建表语句和预置数据
const EXEMPT = ['server/core/schema/tables/'];

const lineCount = (text) => (text ? String(text).split('\n').length : 0);

/** 这次写了哪些文件、各自是不是变长了：正在把大文件拆小的改动不打扰 */
function writtenFiles(input) {
  const args = input?.tool_input || {};
  const tool = input?.tool_name;
  if (tool === 'apply_patch')
    return parsePatch(args.command)
      .filter((file) => file.action !== 'delete')
      .map((file) => ({
        file: file.moveTo || file.path,
        grew: file.action === 'add' || file.added > file.removed,
      }));
  if (!['Write', 'Edit', 'MultiEdit'].includes(tool)) return [];
  const file = args.file_path || input.tool_response?.filePath;
  if (typeof file !== 'string' || !file) return [];
  const edits = Array.isArray(args.edits) ? args.edits : [args];
  const grew =
    tool === 'Write' || edits.some((edit) => lineCount(edit?.new_string) > lineCount(edit?.old_string));
  return [{ file, grew }];
}

function reminder(file, cwd) {
  const full = absolute(cwd, file);
  const path = relative(HOOK_ROOT, full).replaceAll('\\', '/');
  if (path.startsWith('..') || !DIRS.includes(path.split('/')[0])) return '';
  if (!EXTS.includes(extname(path)) || EXEMPT.some((prefix) => path.startsWith(prefix))) return '';
  let lines;
  try {
    lines = lineCount(readFileSync(full, 'utf8'));
  } catch {
    // 一份文件读不到，仍可提醒同一补丁中的其他文件。
    return '';
  }
  if (lines <= SOFT) return '';
  return lines > HARD
    ? `提醒：${path} 现在 ${lines} 行，超过了 500 行的上限（AGENTS.md“文件怎么分”）。这次改动又让它变长了：先按职责拆开，再继续加东西；没有特殊理由不能留着。`
    : `提醒：${path} 现在 ${lines} 行，超过了 300 行（AGENTS.md“文件怎么分”：尽量 100 到 300 行）。先想这次加的东西能不能写得更简单，或者放进一个只管这件事的文件。`;
}

try {
  const input = await readStdinJson();
  const cwd = hookCwd(input);
  const text = writtenFiles(input)
    .filter((written) => written.grew)
    .map((written) => reminder(written.file, cwd))
    .filter(Boolean)
    .join('\n');
  if (text)
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }),
    );
} catch {
  // 输入坏了不打扰。
}
