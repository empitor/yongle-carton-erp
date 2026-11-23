// 每个测试文件都被跑到：tests/ 下（含子目录）每个测试文件恰好属于一个套件。列文件用运行器自己的 suites（scripts/run-tests.mjs），
// 不另抄一份。子目录里的测试归主套件；tests/release/ 是发布检查、tests/serial/ 是串行组；tests/fixtures/ 放测试数据，不放测试。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SUITE_DIRS, TEST_FILE, suites, testTree } from '../../scripts/run-tests.mjs';

/** 看着像测试的文件，不管后缀是不是运行器认的 */
const looksLikeTest = (f) => /\.test\.[cm]?[jt]sx?$/.test(f);

const whyNotRun = (f) =>
  !TEST_FILE.test(f)
    ? '运行器只认 .test.ts 和 .test.mjs，这个文件不会跑；改成这两种后缀'
    : f.startsWith(SUITE_DIRS.fixtures)
      ? SUITE_DIRS.fixtures + ' 只放测试数据，这里的测试不会跑；挪到 tests/ 或它别的子目录'
      : '不在任何套件里，不会跑；查 scripts/run-tests.mjs 的 suites';

/** tree：tests/ 下的全部文件；s：{ 套件名: 文件 }。不属于任何套件、或同时属于几个的，各一句写明哪个文件、怎么改 */
function suiteProblems(tree, s) {
  return tree.filter(looksLikeTest).flatMap((f) => {
    const owners = Object.entries(s).flatMap(([name, files]) => (files.includes(f) ? [name] : []));
    if (owners.length === 1) return [];
    if (owners.length > 1) return [`${f}：同时在 ${owners.join('、')} 几个套件里，会跑两遍；改 scripts/run-tests.mjs 的 suites 让它只归一个`];
    return [f + '：' + whyNotRun(f)];
  });
}

/** 造一个临时项目，只有 tests/ 下这几个空文件，用完删掉 */
function withSample(files, check) {
  const base = mkdtempSync(join(tmpdir(), 'erp-test-suites-'));
  try {
    for (const f of files) {
      mkdirSync(dirname(join(base, f)), { recursive: true });
      writeFileSync(join(base, f), '');
    }
    check(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('项目里 tests/ 下（含子目录）每个测试文件恰好属于一个套件', () => {
  assert.deepEqual(suiteProblems(testTree(), suites()), []);
});

test('放进子目录的测试会被找到：别的子目录归主套件，release/ 归发布检查，serial/ 归串行组，fixtures/ 和辅助文件不算', () => {
  const files = [
    'tests/a.test.ts',
    'tests/a-fixture.ts',
    'tests/finance/b.test.ts',
    'tests/finance/deep/c.test.mjs',
    'tests/release/d.test.ts',
    'tests/release/sub/e.test.mjs',
    'tests/serial/f.test.mjs',
    'tests/fixtures/import/g.json',
  ];
  withSample(files, (base) => {
    assert.deepEqual(suites(base), {
      main: ['tests/a.test.ts', 'tests/finance/b.test.ts', 'tests/finance/deep/c.test.mjs'],
      serial: ['tests/serial/f.test.mjs'],
      release: ['tests/release/d.test.ts', 'tests/release/sub/e.test.mjs'],
    });
    assert.deepEqual(suiteProblems(testTree(base), suites(base)), []);
  });
});

test('运行器不认的后缀、放进测试数据目录的测试：报出来，写明怎么改', () => {
  withSample(['tests/ok.test.ts', 'tests/ui/page.test.tsx', 'tests/fixtures/old.test.ts'], (base) => {
    const problems = suiteProblems(testTree(base), suites(base));
    assert.equal(problems.length, 2);
    assert.match(problems[0], /^tests\/fixtures\/old\.test\.ts：tests\/fixtures\/ 只放测试数据，这里的测试不会跑/);
    assert.match(problems[1], /^tests\/ui\/page\.test\.tsx：运行器只认 \.test\.ts 和 \.test\.mjs/);
  });
});

test('同一个测试文件被两个套件跑：报出来', () => {
  const problems = suiteProblems(['tests/a.test.ts'], { main: ['tests/a.test.ts'], serial: ['tests/a.test.ts'], release: [] });
  assert.deepEqual(problems, ['tests/a.test.ts：同时在 main、serial 几个套件里，会跑两遍；改 scripts/run-tests.mjs 的 suites 让它只归一个']);
});
