// 数据管理（本机管理员）的请求：列表、执行指令、识别文件复制、初始化业务数据。页面和给别的模块的服务接口都走这里。
import type { BusinessResetScope, DataManagementApi } from '../../shared/admin/index';
import { AUDIT_SOURCE } from '../../shared/core/index';
import { call } from '../ui/index';
import type { ManagedModule } from './record-types';

const management = call<DataManagementApi>();
/** 数据管理的指令：改、归档、恢复都要写原因，留审计；entry 是从数据管理窗口做的标记（审计来源记成“数据管理”） */
type ManagementCommand = DataManagementApi['POST /management/execute']['body'];

/** 一个模块的记录（数据管理列表，和编辑窗里的关联候选） */
export const readRecords = (module: ManagedModule) => management('GET /management/records', { query: { module } });
/** AI 识别工作区：进行中的和回收站的 */
export const readWorkspaces = () => management('GET /management/workspaces');

/** 执行数据管理指令（改、归档、恢复、确认、撤销、取消、新建；删除走删除窗的 /deletions/execute，见 recordkit/record-api.ts） */
export const executeCommand = (command: ManagementCommand) => management('POST /management/execute', { body: command });

/** 从数据管理窗口做的指令：带上“数据管理”入口标记（审计来源记成数据管理）和维护原因 */
export const dataManagementCommand = (command: Omit<ManagementCommand, 'reason' | 'entry'>): ManagementCommand => ({
  ...command,
  reason: '管理员数据维护',
  entry: AUDIT_SOURCE.dataManagement,
});

/** 把识别文件复制成新的识别任务；同一次操作重试时传同一个 requestId，服务端不会复制两份 */
export const forkWorkspaces = (items: { id: string; revision?: number }[], requestId: string = crypto.randomUUID()) =>
  management('POST /management/workspaces', { body: { action: 'fork', requestId, items } });

/** 清理影响（各表条数；连财务一起清时带已结账的月份和摘要） */
export const readResetPreview = (scope: BusinessResetScope, clearClosedFinance: boolean) =>
  management('GET /management/reset-preview', {
    query: { scope, ...(clearClosedFinance ? { clearClosedFinance: '1' } : {}) },
  });
export const resetData = (body: DataManagementApi['POST /management/reset']['body']) =>
  management('POST /management/reset', { body });
