// 每次会话都整份读进来的规则文件（AGENTS.md、CLAUDE.md）不许再长回去：这里只放硬规则和“改某块之前读哪份”，
// 只在改某块时才要的细节放 docs/ 对应那份（读的时候才进上下文）。字数按字符算，换行一律按 LF 数，和检出方式无关。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** 上限 = 定下时的字数加一成左右的余量；调高算放宽检查，要用户同意（AGENTS.md“碰不得的”） */
const limits: Record<string, number> = {
  'AGENTS.md': 3760,
  'CLAUDE.md': 650,
};

const length = (file: string) => [...readFileSync(file, 'utf8').replace(/\r\n/g, '\n')].length;

test('每次会话都读的 AGENTS.md、CLAUDE.md 不超过字数上限', () => {
  const over = Object.entries(limits)
    .map(([file, limit]) => ({ file, limit, size: length(file) }))
    .filter((f) => f.size > f.limit)
    .map(
      (f) =>
        `${f.file} 有 ${f.size} 字，上限 ${f.limit} 字：细节搬进 docs/ 对应那份，别加在这里` +
        '（这里只留硬规则和“改某块之前读哪份”的指引）',
    );
  assert.deepEqual(over, []);
});
