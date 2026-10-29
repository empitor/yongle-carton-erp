import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import {
  createRuntimeControl,
  requestRuntimeStop,
  readControl,
  controlFile,
} from '../scripts/runtime-control.mjs';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ERP 本机控制测试-'));
  return {
    database: join(directory, '虚构 库.sqlite'),
    cleanup: () =>
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}

test('关闭回执只在资源关闭后返回，并移除本实例控制凭据', async () => {
  const f = fixture();
  let closed = false;
  const control = await createRuntimeControl(f.database, async () => {
    await new Promise((done) => setTimeout(done, 10));
    closed = true;
  });
  try {
    await requestRuntimeStop(f.database, process.pid);
    assert.equal(closed, true);
    await control.close();
    assert.equal(existsSync(controlFile(f.database)), false);
  } finally {
    await control.close();
    f.cleanup();
  }
});

test('PID不匹配、无效凭据及错误令牌不会执行停止', async () => {
  const f = fixture();
  let stops = 0;
  const control = await createRuntimeControl(f.database, () => {
    stops++;
  });
  try {
    await assert.rejects(requestRuntimeStop(f.database, process.pid + 1), /PID不符/);
    const record = readControl(f.database);
    const reply = await new Promise((done, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: record.port });
      let output = '';
      socket.once('error', reject);
      socket.once('connect', () =>
        socket.end(
          JSON.stringify({ action: 'stop', pid: process.pid, token: '0'.repeat(64) }) + '\n',
        ),
      );
      socket.on('data', (b) => {
        output += b;
      });
      socket.once('end', () => done(JSON.parse(output)));
    });
    assert.equal(reply.ok, false);
    assert.equal(stops, 0);
    const original = readFileSync(controlFile(f.database));
    writeFileSync(controlFile(f.database), '{"app":"other"}');
    await assert.rejects(requestRuntimeStop(f.database, process.pid), /凭据无效/);
    writeFileSync(controlFile(f.database), original);
    assert.equal(stops, 0);
  } finally {
    await control.close();
    f.cleanup();
  }
});

test('关闭失败返回失败回执，保留凭据供核验，不伪报成功', async () => {
  const f = fixture();
  const control = await createRuntimeControl(f.database, () => {
    throw new Error('虚构关闭失败');
  });
  try {
    await assert.rejects(requestRuntimeStop(f.database, process.pid), /未返回正常关闭回执/);
    assert.equal(readControl(f.database).pid, process.pid);
  } finally {
    await control.close();
    f.cleanup();
  }
});

test('空值、非法JSON及超大控制消息被拒绝，服务继续可用', async () => {
  const f = fixture();
  let stops = 0;
  const control = await createRuntimeControl(f.database, () => {
    stops++;
  });
  try {
    const record = readControl(f.database);
    for (const message of ['null\n', 'false\n', '{bad-json}\n', 'x'.repeat(4097)]) {
      await new Promise((done) => {
        const socket = createConnection({ host: '127.0.0.1', port: record.port });
        socket.on('error', () => {});
        socket.on('data', () => {});
        socket.once('connect', () => socket.end(message));
        socket.once('close', done);
      });
    }
    assert.equal(stops, 0);
    await requestRuntimeStop(f.database, process.pid);
    assert.equal(stops, 1);
  } finally {
    await control.close();
    f.cleanup();
  }
});

test('旧控制器清理不能删除后来替换的其他实例凭据', async () => {
  const f = fixture();
  const control = await createRuntimeControl(f.database, () => {});
  const newer = { ...readControl(f.database), token: '1'.repeat(64) };
  try {
    writeFileSync(controlFile(f.database), JSON.stringify(newer));
    await control.close();
    assert.equal(readControl(f.database).token, newer.token);
  } finally {
    await control.close();
    f.cleanup();
  }
});

test(
  'Windows停止CMD保留npm失败退出码，不被pause覆盖',
  { skip: process.platform !== 'win32' },
  async () => {
    const f = fixture(),
      directory = join(f.database, '..');
    writeFileSync(join(directory, '停止系统.cmd'), readFileSync('停止系统.cmd'));
    writeFileSync(join(directory, 'npm.cmd'), '@echo off\r\nexit /b 7\r\n');
    try {
      const result = await new Promise((done, reject) => {
        const child = spawn(
          process.env.ComSpec || 'cmd.exe',
          ['/d', '/s', '/c', 'call "' + join(directory, '停止系统.cmd') + '"'],
          {
            cwd: directory,
            windowsHide: true,
            windowsVerbatimArguments: true,
            stdio: 'ignore',
          },
        );
        child.once('error', reject);
        child.once('exit', done);
      });
      assert.equal(result, 7);
    } finally {
      f.cleanup();
    }
  },
);
