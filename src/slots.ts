// 装配：把各模块提供的组件和服务填进 src/ui/slots.tsx 定义好的插槽，main.tsx 渲染 App 时用。
import { lazy } from 'react';
import type { Slots } from './ui/index';
import { financeService } from './finance/index';
import { aiFilesService, inboxService, workspaceFilesService } from './import/index';
import { adminService } from './admin/index';
import { partiesService } from './records/index';

// 订单、送货、到货详情里的财务段：只有有财务权限的账号用得上，按需加载，不把财务公共件带进主包
const FinanceRelated = lazy(() => import('./finance/pages').then((m) => ({ default: m.FinanceRelated })));
// 数据管理编辑窗：只有本机管理员用，按需加载
const DataManagementEditor = lazy(() => import('./admin/pages').then((m) => ({ default: m.DataManagementEditor })));

export const slots: Slots = {
  FinanceRelated,
  DataManagementEditor,
  aiFiles: aiFilesService,
  inbox: inboxService,
  finance: financeService,
  parties: partiesService,
  admin: adminService,
  workspaceFiles: workspaceFilesService,
};
