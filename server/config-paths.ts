import { homedir } from 'node:os';
import { posix, win32, resolve } from 'node:path';

/** 凭据目录独立于业务库；Windows 默认路径保持兼容。 */
export function configDirectory(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
) {
  const path = platform === 'win32' ? win32 : posix;
  if (env.ERP_CONFIG_DIR) {
    if (!path.isAbsolute(env.ERP_CONFIG_DIR)) throw new Error('ERP_CONFIG_DIR 必须是绝对路径。');
    return path.normalize(env.ERP_CONFIG_DIR);
  }
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ZhixuERP');
  if (env.XDG_CONFIG_HOME && !path.isAbsolute(env.XDG_CONFIG_HOME))
    throw new Error('XDG_CONFIG_HOME 必须是绝对路径。');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'zhixu-erp');
}

export const masterKeyName = 'master.key';
export const backupDirectory = () => resolve(process.env.ERP_BACKUP_DIR || 'backups');
