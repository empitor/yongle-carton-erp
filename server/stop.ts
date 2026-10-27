import { readFileSync } from 'node:fs';
import { defaultDbPath } from './db.js';

// 只有运行锁与本机服务返回的进程号一致时才停止，避免误关其他程序。
try {
  const pid = Number(readFileSync(defaultDbPath + '.running', 'utf8'));
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3001}/api/health`, {
    signal: AbortSignal.timeout(3000),
  });
  const health = await response.json();
  if (!response.ok || health.app !== 'carton-workshop-erp' || health.processId !== pid) {
    throw new Error('未能确认运行中的服务身份，未停止任何程序。');
  }
  process.kill(pid, 'SIGTERM');
  console.log('已向本机 ERP 服务发送停止信号。重新启动可双击“启动系统.cmd”。');
} catch (error) {
  console.error('停止失败：' + (error as Error).message + ' 请检查服务窗口。');
  process.exitCode = 1;
}
