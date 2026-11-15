import { defaultAiSettingsPath } from './ai/index.js';
import { defaultBotSettingsPath } from './inbox/index.js';

/**
 * 放在配置目录里、备份时另存到 _extra 的本机配置：_extra 里的名字 → 这台机器上的位置。
 * 每日备份、助手做的备份（server/index.ts）和维护命令行的备份、恢复（server/maintenance.ts）都用这一份。
 */
export const backupExtraFiles = () => ({
  'ai-settings.sqlite': defaultAiSettingsPath(),
  'bots.sqlite': defaultBotSettingsPath(),
});
