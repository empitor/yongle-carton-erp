// 装配：把各模块提供的组件和服务填进 src/ui/slots.tsx 定义好的插槽，main.tsx 启动时调 assembleSlots，渲染 App 时用。
import { lazy } from 'react';
import type { Slots } from './ui/index';
import { financeService } from './finance/index';
import { aiFilesService, inboxService, workspaceFilesService } from './import/index';
import { adminService } from './admin/index';
import { inAndroidApp, startAppBridge } from './app-bridge';
import { APP_SAVE_TIMEOUT_MS, createAppSaver } from './app-save';

// 订单、送货、到货详情里的财务段：只有有财务权限的账号用得上，按需加载，不把财务公共件带进主包
const FinanceRelated = lazy(() => import('./finance/pages').then((m) => ({ default: m.FinanceRelated })));
// 数据管理编辑窗：只有本机管理员用，按需加载
const DataManagementEditor = lazy(() => import('./admin/pages').then((m) => ({ default: m.DataManagementEditor })));

const slots: Slots = {
  FinanceRelated,
  DataManagementEditor,
  aiFiles: aiFilesService,
  inbox: inboxService,
  finance: financeService,
  admin: adminService,
  workspaceFiles: workspaceFilesService,
};

/**
 * 页面启动时调一次：接上安卓 App 的通道（返回键、分享文件、保存文件；浏览器里没人来接通，什么都不做），交出插槽。
 * App 里保存内存里的文件交给 App（插槽 saveFile，和通道用同一个保存那一头），没接通时保存会报错，不会假装存好；
 * 浏览器和 Windows 外壳不填，交给浏览器下载。
 */
export function assembleSlots(): Slots {
  const appSaver = createAppSaver(APP_SAVE_TIMEOUT_MS);
  startAppBridge(window, appSaver);
  return inAndroidApp(navigator.userAgent) ? { ...slots, saveFile: appSaver.save } : slots;
}
