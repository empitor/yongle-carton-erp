// 识别导入给别的模块用的服务接口（由 src/slots.ts 装进插槽，接口定义在 src/ui/slots.tsx）
import { importStillOpen } from '../../shared/import/index';
import { fileStatus } from './fileStatus';
import { readInbox } from './inbox-api';
import { changeWorkspaceFiles, readImports } from './workspace-api';

/** 收件箱：今日页列待处理的 */
export const inboxService = {
  async pending(limit: number) {
    const v = await readInbox({ status: 'pending', channel: '', q: '', page: 1 }, limit);
    return { rows: v.rows, total: v.filteredRecords };
  },
};

/** 今日页里的 AI 识别文件：还要人处理的那些，和每份的进度文字 */
export const aiFilesService = {
  async open() {
    return (await readImports()).workspaces.filter((w) => importStillOpen(w));
  },
  note: fileStatus,
};

/** 识别文件的归档、恢复、永久删除（数据管理也走这里） */
export const workspaceFilesService = { change: changeWorkspaceFiles };
