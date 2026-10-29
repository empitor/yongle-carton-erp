// 本机进程控制通道；不提供HTTP业务接口，令牌仅保存在受忽略的运行文件中。
import { createServer, createConnection } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

export const controlFile = (database) => resolve(database) + '.control';
export function readControl(database) {
  let record;
  try {
    record = JSON.parse(readFileSync(controlFile(database), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new Error(
        '此实例没有正常关闭通道。旧版服务请在原启动窗口按Ctrl+C，再启动新版；未强制结束任何程序。',
      );
    throw new Error('本机运行凭据无效，未停止任何程序。');
  }
  if (
    !record ||
    typeof record !== 'object' ||
    record.app !== 'carton-workshop-erp' ||
    !Number.isInteger(record.pid) ||
    record.pid < 1 ||
    !Number.isInteger(record.port) ||
    record.port < 1 ||
    record.port > 65535 ||
    !/^[a-f0-9]{64}$/.test(record.token)
  )
    throw new Error('本机运行凭据无效，未停止任何程序。');
  return record;
}

export async function createRuntimeControl(database, onStop, afterStop = () => {}) {
  const file = controlFile(database),
    token = randomBytes(32).toString('hex');
  let stopping = false;
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(5000, () => socket.destroy());
    let input = '';
    socket.on('data', (data) => {
      input += data.toString('utf8');
      if (input.length > 4096) return socket.destroy();
      if (!input.includes('\n')) return;
      socket.removeAllListeners('data');
      let request;
      try {
        request = JSON.parse(input.trim());
      } catch {
        return socket.destroy();
      }
      if (
        !request ||
        typeof request !== 'object' ||
        request.action !== 'stop' ||
        request.pid !== process.pid ||
        typeof request.token !== 'string' ||
        !/^[a-f0-9]{64}$/.test(request.token) ||
        !timingSafeEqual(Buffer.from(request.token), Buffer.from(token))
      ) {
        socket.end(JSON.stringify({ ok: false }) + '\n');
        return;
      }
      if (stopping) return socket.end(JSON.stringify({ ok: false }) + '\n');
      stopping = true;
      socket.setTimeout(30000);
      Promise.resolve()
        .then(onStop)
        .then(
          () => {
            socket.end(JSON.stringify({ ok: true, pid: process.pid }) + '\n', () => {
              void close().then(afterStop);
            });
          },
          () => {
            stopping = false;
            socket.end(JSON.stringify({ ok: false }) + '\n');
          },
        );
    });
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const port = server.address().port;
  try {
    // 数据库的原运行锁已由调用方取得，只有同一实例可创建/替换此运行凭据。
    writeFileSync(
      file,
      JSON.stringify({ app: 'carton-workshop-erp', pid: process.pid, port, token }),
      { mode: 0o600 },
    );
  } catch (error) {
    server.close();
    throw error;
  }
  let closing;
  function close() {
    return (closing ||= new Promise((done) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => {
        try {
          if (readControl(database).token === token) unlinkSync(file);
        } catch {
          /* 已清理 */
        }
        done();
      });
    }));
  }
  return { close };
}

export async function requestRuntimeStop(database, expectedPid) {
  const record = readControl(database);
  if (record.pid !== expectedPid) throw new Error('本机运行凭据与服务PID不符，未停止任何程序。');
  return new Promise((done, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: record.port });
    let output = '',
      settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? reject(error) : done();
    };
    socket.setTimeout(30000, () => finish(new Error('等待本机服务正常关闭超时。')));
    socket.once('error', () => finish(new Error('本机关闭通道不可用，未强制结束任何程序。')));
    socket.once('connect', () =>
      socket.write(
        JSON.stringify({ action: 'stop', pid: expectedPid, token: record.token }) + '\n',
      ),
    );
    socket.on('data', (data) => {
      output += data.toString('utf8');
      if (output.length > 4096) return finish(new Error('本机关闭回执无效。'));
      if (!output.includes('\n')) return;
      try {
        const result = JSON.parse(output.trim());
        if (result.ok !== true || result.pid !== expectedPid) throw new Error();
        finish();
      } catch {
        finish(new Error('服务未返回正常关闭回执。'));
      }
    });
    socket.once('end', () => {
      if (!settled) finish(new Error('本机关闭通道中断，请核验服务状态。'));
    });
    socket.once('close', () => {
      if (!settled) finish(new Error('本机关闭连接已中断，请核验服务状态。'));
    });
  });
}
