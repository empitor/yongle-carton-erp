import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';

const [configFile, logDirectory] = process.argv.slice(2);
if (!configFile || !logDirectory || ![configFile, logDirectory].every(isAbsolute))
  throw new Error('请指定部署配置和日志的绝对路径。');
mkdirSync(logDirectory, { recursive: true });
const log = join(logDirectory, 'erp.log');
const maxBytes = 10 * 1024 * 1024;
const archives = 7;
let bytes = existsSync(log) ? statSync(log).size : 0;
function write(chunk) {
  if (bytes && bytes + chunk.length > maxBytes) {
    rmSync(`${log}.${archives}`, { force: true });
    for (let n = archives - 1; n >= 1; n--)
      if (existsSync(`${log}.${n}`)) renameSync(`${log}.${n}`, `${log}.${n + 1}`);
    renameSync(log, log + '.1');
    bytes = 0;
  }
  appendFileSync(log, chunk);
  bytes += chunk.length;
}
const allowed = new Set([
  'ERP_DEPLOYMENT',
  'PORT',
  'ERP_PROXY_PORT',
  'ERP_ALLOWED_HOSTS',
  'ERP_ALLOWED_ORIGINS',
  'ERP_BACKUP_COPY_DIR',
  'ERP_BACKUP_COPY_KEEP',
]);
try {
  const config = JSON.parse(readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
  if (
    !config ||
    Array.isArray(config) ||
    typeof config !== 'object' ||
    config.ERP_DEPLOYMENT !== '1'
  )
    throw new Error('配置必须是 ERP_DEPLOYMENT 为 1 的 JSON 对象。');
  if (Object.entries(config).some(([key, value]) => !allowed.has(key) || typeof value !== 'string'))
    throw new Error('部署配置只能包含文档所列的字符串设置。');
  if (config.ERP_BACKUP_COPY_DIR && !isAbsolute(config.ERP_BACKUP_COPY_DIR))
    throw new Error('备份复制目录必须使用绝对路径。');
  const env = { ...process.env };
  for (const key of allowed) delete env[key];
  Object.assign(env, config);
  env.NODE_ENV = 'production';
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  write(Buffer.from(`\n[${new Date().toISOString()}] ERP 计划任务启动\n`));
  child.stdout.on('data', write);
  child.stderr.on('data', write);
  child.once('error', () => {
    write(Buffer.from('无法启动 ERP Node 子进程。\n'));
    process.exitCode = 1;
  });
  child.once('close', (code, signal) => {
    write(Buffer.from(`[${new Date().toISOString()}] ERP 已退出（${code ?? signal}）\n`));
    process.exitCode = code ?? 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
} catch (error) {
  write(
    Buffer.from(`[${new Date().toISOString()}] 无法加载部署配置（请检查文件权限和 JSON 设置）。\n`),
  );
  process.exitCode = 1;
}
