// 构建脚本（scripts/build.mjs）出错时不留半成品：在临时目录里放一份脚本和一个必定失败的 tsc 跑一遍。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('构建中途类型检查失败：退出码 1，临时构建目录删掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-build-failure-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'node_modules/typescript/bin'), { recursive: true });
    writeFileSync(join(dir, 'scripts/build.mjs'), readFileSync('scripts/build.mjs'));
    writeFileSync(join(dir, 'node_modules/typescript/bin/tsc'), 'process.exit(1)');
    const run = spawnSync(process.execPath, [join(dir, 'scripts/build.mjs')], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.equal(existsSync(join(dir, '.build-tmp')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
