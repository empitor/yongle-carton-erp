// 数据管理给别的模块用的服务接口（由 src/slots.ts 装进插槽，接口定义在 src/ui/slots.tsx）
import type { AdminService } from '../ui/index';
import { forkWorkspaces } from './data-api';

/** 本机管理员复制 AI 识别文件 */
export const adminService: AdminService = {
  forkWorkspace: (id) => forkWorkspaces([{ id }]),
};
