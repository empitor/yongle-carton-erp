// 函数复杂度“只许变小”（scripts/complexity-ratchet.mjs）：用假的 ESLint 结果测取数和比对，不真跑 ESLint。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { compare, measure, tighten } from '../scripts/complexity-ratchet.mjs';

const root = join('C:', 'repo');
const result = (file, ...messages) => ({ filePath: join(root, file), messages: messages.map(([ruleId, message]) => ({ ruleId, message })) });

test('取数：四条规则的数按“文件、指标、函数名”记，同名的从大到小排；嵌套按文件；别的规则不管', () => {
  const now = measure(
    [
      result(
        'src/a.tsx',
        ['max-lines-per-function', "Function 'OrderEditor' has too many lines (381). Maximum allowed is 150."],
        ['max-lines-per-function', 'Arrow function has too many lines (95). Maximum allowed is 80.'],
        ['max-lines-per-function', 'Arrow function has too many lines (120). Maximum allowed is 80.'],
        ['complexity', "Async method 'save' has a complexity of 25. Maximum allowed is 20."],
        ['max-params', "Function 'make' has too many parameters (7). Maximum allowed is 5."],
        ['max-depth', 'Blocks are nested too deeply (6). Maximum allowed is 4.'],
        ['no-empty', 'Empty block statement.'],
      ),
    ],
    root,
  );
  assert.deepEqual(now, {
    "src/a.tsx :: 行数 :: Function 'OrderEditor'": [381],
    'src/a.tsx :: 行数 :: Arrow function': [120, 95],
    "src/a.tsx :: 复杂度 :: Async method 'save'": [25],
    "src/a.tsx :: 参数 :: Function 'make'": [7],
    'src/a.tsx :: 嵌套': [6],
  });
});

test('比对：登记过的函数变大、多出新超标的都要失败；变小、少了的只提示；同名的换了顺序不误报', () => {
  const base = { 'a :: 行数 :: f': [90], 'a :: 行数 :: Arrow function': [120, 95], 'a :: 嵌套': [5] };
  assert.deepEqual(compare({ 'a :: 行数 :: f': [300], 'a :: 行数 :: Arrow function': [120, 95], 'a :: 嵌套': [5] }, base).grown, [{ key: 'a :: 行数 :: f', was: 90, now: 300 }]);
  const more = compare({ ...base, 'a :: 行数 :: Arrow function': [120, 95, 81], 'b :: 参数 :: g': [6] }, base);
  assert.deepEqual(more.fresh, [
    { key: 'a :: 行数 :: Arrow function', now: 81 },
    { key: 'b :: 参数 :: g', now: 6 },
  ]);
  const less = compare({ 'a :: 行数 :: f': [85], 'a :: 行数 :: Arrow function': [100] }, base);
  assert.deepEqual([less.grown, less.fresh], [[], []]);
  assert.equal(less.shrunk.length, 4);
  assert.deepEqual(compare(base, base), { grown: [], fresh: [], shrunk: [] });
});

test('基线跟着改小：取较小的数、删掉没了的，不加新的、不改大', () => {
  const base = { 'a :: 行数 :: f': [90], 'a :: 行数 :: Arrow function': [120, 95], 'a :: 嵌套': [5] };
  const now = { 'a :: 行数 :: f': [100], 'a :: 行数 :: Arrow function': [110], 'b :: 参数 :: g': [6] };
  assert.deepEqual(tighten(now, base), { 'a :: 行数 :: f': [90], 'a :: 行数 :: Arrow function': [110] });
});
