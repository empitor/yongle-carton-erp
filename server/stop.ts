import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { errorMessage } from '../shared/core/index.js';
import { defaultDbPath } from './core/index.js';
import { DEFAULT_PORT, SERVICE_APP_NAME } from './local-service.js';
import { requestRuntimeStop } from '../scripts/runtime-control.mjs';

/** 问本机服务是谁最多等几毫秒 */
const HEALTH_TIMEOUT_MS = 3000;
/** 本机端口上的健康检查回答：程序名和进程号 */
const healthSchema = z.object({ app: z.string(), processId: z.number() });

// 只有运行锁与本机服务返回的进程号一致时才停止，避免误关其他程序。
try {
  const pid = Number(readFileSync(defaultDbPath + '.running', 'utf8'));
  const response = await fetch(`http://127.0.0.1:${process.env.PORT || DEFAULT_PORT}/api/health`, {
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  });
  const health = healthSchema.safeParse(await response.json());
  if (!response.ok || !health.success || health.data.app !== SERVICE_APP_NAME || health.data.processId !== pid) {
    throw new Error('未能确认运行中的服务身份，未停止任何程序。');
  }
  await requestRuntimeStop(defaultDbPath, pid);
  console.log('本机 ERP 服务已正常关闭。重新启动可双击“启动系统.cmd”。');
} catch (error) {
  console.error('停止失败：' + errorMessage(error) + ' 请检查服务窗口。');
  process.exitCode = 1;
}
