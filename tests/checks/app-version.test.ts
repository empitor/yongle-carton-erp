// 程序版本号只有一个来源：包、锁文件和 shared/core/version.ts 三处一致（不写死具体版本号，否则每次发版都要改测试）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { APP_VERSION } from '../../shared/core/version.js';

const versioned = z.object({ version: z.string() });

test('版本号的包、锁文件和程序里用的是同一个', () => {
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
  for (const file of ['package.json', 'package-lock.json'])
    assert.equal(versioned.parse(JSON.parse(readFileSync(file, 'utf8'))).version, APP_VERSION, file);
});
