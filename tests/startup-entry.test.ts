// 运行锁（server/core/storage/lock.ts）：两个进程不同时写一个库；起子进程测启动入口的在 tests/release/startup-entry.test.ts。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { acquireLock } from '../server/core/index.js';
import { workspace } from './schema-fixture.js';

test('运行锁：写进本进程号，放锁只删自己写的；活着的进程占着就拒绝，死掉的进程留下的锁接管，内容不认识的拒绝', () => {
  const w = workspace('erp-lock-');
  const file = w.path + '.running';
  try {
    const unlock = acquireLock(w.path);
    assert.equal(readFileSync(file, 'utf8'), String(process.pid));
    assert.throws(() => acquireLock(w.path), /^Error: 数据库正在使用，请先关闭 ERP 服务和其他维护命令。$/, '本进程还活着');
    unlock();
    assert.equal(existsSync(file), false);

    // 已经结束的进程留下的锁：接管
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    writeFileSync(file, String(dead));
    const again = acquireLock(w.path);
    assert.equal(readFileSync(file, 'utf8'), String(process.pid));
    // 锁被别人换掉了（比如人工处理后别的进程拿到）：放锁时不删别人的
    writeFileSync(file, String(dead));
    again();
    assert.equal(readFileSync(file, 'utf8'), String(dead));

    for (const text of ['', 'abc', '-3', '1.5']) {
      writeFileSync(file, text);
      assert.throws(() => acquireLock(w.path), /^Error: 运行锁异常，请人工检查 /, JSON.stringify(text));
      assert.equal(readFileSync(file, 'utf8'), text, '不认识的锁原样留着');
    }
  } finally {
    w.close();
  }
});
