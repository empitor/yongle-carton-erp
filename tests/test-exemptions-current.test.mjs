// 测试检查的登记表（scripts/test-exemptions.mjs）不留过期的条目。
// 这里查：登记的文件都还在，慢测试登记的文件在主套件里（只有主套件查慢测试）。
// 跑的时候才知道的两类，由跑的那一步拦，这里用样例证明会拦：文件跑了却没有登记的那条测试（npm test，test-slow.mjs）、
// 覆盖已经达标（npm run test:coverage，test-coverage.mjs）。慢测试单独跑已经不慢了只提示（和机器快慢有关），不在这里查。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lowCoverage as coverageExempt, slowTests } from '../scripts/test-exemptions.mjs';
import { suites } from '../scripts/run-tests.mjs';
import { missingSlowExemptions } from '../scripts/test-slow.mjs';
import { reportCoverage } from '../scripts/test-coverage.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const TABLE = 'scripts/test-exemptions.mjs';

/** 登记的文件不在了：slow 和 coverage 是两张登记表，mainSuite 是主套件的测试文件，exists 判断项目里有没有这个文件 */
function staleFiles({ slow, coverage }, mainSuite, exists) {
  return [
    ...Object.keys(slow)
      .filter((f) => !mainSuite.includes(f))
      .map((f) => `${TABLE} 的 slowTests 登记了 ${f}，它不是主套件里的测试文件（文件没了、改了名，或放进了 release/、serial/，那里不查慢测试）；删掉这条或改成现在的路径`),
    ...Object.keys(coverage)
      .filter((f) => !exists(f))
      .map((f) => `${TABLE} 的 lowCoverage 登记了 ${f}，这个文件已经不在了；删掉这条或改成现在的路径`),
  ];
}

test('登记表里的文件都还在：慢测试登记的在主套件里，低覆盖登记的在项目里', () => {
  const exists = (f) => existsSync(join(root, f));
  assert.deepEqual(staleFiles({ slow: slowTests, coverage: coverageExempt }, suites().main, exists), []);
});

test('登记的文件没了、慢测试登记在主套件以外的文件：报出来，写明哪张表、哪个文件', () => {
  const registered = {
    slow: { 'tests/a.test.ts': { 甲: '原因' }, 'tests/gone.test.ts': { 乙: '原因' }, 'tests/release/r.test.ts': { 丙: '原因' } },
    coverage: { 'server/a.ts': '原因', 'server/gone.ts': '原因' },
  };
  const problems = staleFiles(registered, ['tests/a.test.ts'], (f) => f === 'server/a.ts');
  assert.equal(problems.length, 3);
  assert.match(problems[0], /slowTests 登记了 tests\/gone\.test\.ts，它不是主套件里的测试文件/);
  assert.match(problems[1], /slowTests 登记了 tests\/release\/r\.test\.ts/);
  assert.match(problems[2], /lowCoverage 登记了 server\/gone\.ts，这个文件已经不在了/);
});

test('慢测试登记了、文件这一轮跑了却没有这条：算找不到；有这条的、文件这一轮没跑的不算', () => {
  const exempt = { 'tests/a.test.ts': { 甲: '原因', 改名了: '原因' }, 'tests/b.test.ts': { 乙: '原因' } };
  const records = [{ file: 'tests/a.test.ts', name: '甲', ms: 1500 }];
  assert.deepEqual(missingSlowExemptions(records, exempt), [{ file: 'tests/a.test.ts', name: '改名了' }]);
  assert.deepEqual(missingSlowExemptions(records, { 'tests/a.test.ts': { 甲: '原因' } }), []);
});

/** 造一个只有 server/、shared/ 几份源码的临时项目，用完删掉 */
function withSources(files, check) {
  const base = mkdtempSync(join(tmpdir(), 'erp-coverage-exempt-'));
  try {
    for (const d of ['server', 'shared']) mkdirSync(join(base, d));
    for (const f of files) writeFileSync(join(base, f), 'export const value = 1;\n');
    // 和运行器传进来的项目根目录一样，带末尾的分隔符
    check(base + '/');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('低覆盖登记了、但已经达标或文件没了：覆盖检查算失败；登记的确实还低的不算', () => {
  withSources(['server/full.ts', 'server/low.ts'], (base) => {
    // server/full.ts 每行都跑到；server/low.ts 没有测试加载过，按 0% 算
    const lcov = `SF:${join(base, 'server/full.ts')}\nDA:1,3\nend_of_record\n`;
    const quiet = console.log;
    console.log = () => {};
    try {
      assert.equal(reportCoverage(base, [lcov], { 'server/low.ts': '原因' }), 0);
      assert.equal(reportCoverage(base, [lcov], { 'server/low.ts': '原因', 'server/full.ts': '原因', 'server/gone.ts': '原因' }), 2);
    } finally {
      console.log = quiet;
    }
  });
});
