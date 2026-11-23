import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
export function acquireLock(path: string) {
  const file = path + '.running';
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('运行锁异常，请人工检查 ' + file);
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      // 进程已经不在了：上次没清掉的锁，删掉重来；别的错（比如没有权限探测）当它还活着
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') alive = false;
    }
    if (alive) throw new Error('数据库正在使用，请先关闭 ERP 服务和其他维护命令。');
    unlinkSync(file);
  }
  writeFileSync(file, String(process.pid), { flag: 'wx' });
  return () => {
    if (existsSync(file) && readFileSync(file, 'utf8') === String(process.pid)) unlinkSync(file);
  };
}
