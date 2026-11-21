#!/usr/bin/env node
// 写完文件后的提醒：代码、样式、测试文件被写长了，超过 300 行就当场提醒（只提醒，不拦）。
// 规矩在 AGENTS.md“文件怎么分”：尽量 100 到 300 行，500 行封顶。真正守住它的是测试，这里只是发现得更早。
import { readFileSync } from 'node:fs';
import { resolve, relative, extname } from 'node:path';

const SOFT = 300;
const HARD = 500;
const DIRS = ['server', 'shared', 'src', 'tests', 'scripts'];
const EXTS = ['.ts', '.tsx', '.mts', '.mjs', '.js', '.css'];
// 认可的特例：按表逐条罗列的建表语句和预置数据
const EXEMPT = ['server/core/schema/tables/'];

const lineCount = (text) => (text ? String(text).split('\n').length : 0);

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return;
  }
  const args = input.tool_input || {};
  const file = args.file_path || input.tool_response?.filePath;
  if (!file) return;
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const path = relative(root, resolve(root, file)).replaceAll('\\', '/');
  if (path.startsWith('..') || !DIRS.includes(path.split('/')[0])) return;
  if (!EXTS.includes(extname(path)) || EXEMPT.some((prefix) => path.startsWith(prefix))) return;

  // 只在这次改动让文件变长时提醒：正在把大文件拆小的改动不打扰
  const edits = Array.isArray(args.edits) ? args.edits : [args];
  const grew =
    input.tool_name === 'Write' ||
    edits.some((edit) => lineCount(edit.new_string) > lineCount(edit.old_string));
  if (!grew) return;

  let lines;
  try {
    lines = lineCount(readFileSync(resolve(root, file), 'utf8'));
  } catch {
    return;
  }
  if (lines <= SOFT) return;
  const text =
    lines > HARD
      ? `提醒：${path} 现在 ${lines} 行，超过了 500 行的上限（AGENTS.md“文件怎么分”）。这次改动又让它变长了：先按职责拆开，再继续加东西；没有特殊理由不能留着。`
      : `提醒：${path} 现在 ${lines} 行，超过了 300 行（AGENTS.md“文件怎么分”：尽量 100 到 300 行）。先想这次加的东西能不能写得更简单，或者放进一个只管这件事的文件。`;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }),
  );
}

main();
