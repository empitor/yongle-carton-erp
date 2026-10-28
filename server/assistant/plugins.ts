import type { Actor } from '../auth.js';
import type { z } from 'zod';
export type PluginManifest = {
  id: string;
  name: string;
  description: string;
  version: string;
  capabilities: string[];
};
export type PluginTool = {
  name: string;
  description: string;
  arguments: unknown;
  risk: string;
  kind: 'read' | 'business' | 'workflow';
  capability?: 'read' | 'page' | 'write' | 'management';
  schema: z.ZodType;
  permissions?: string[];
  available?: (actor?: Actor | null) => boolean;
  execute?: (args: any, actor: Actor, context: unknown) => unknown | Promise<unknown>;
};
export const builtinPlugins: PluginManifest[] = [
  {
    id: 'erp-business',
    name: 'ERP业务服务',
    description: '客户、产品、销售、采购、库存和生产操作，复用原业务校验、事务和审计。',
    version: '1.0.0',
    capabilities: ['查询与统计', '增删改、归档恢复', '实物流转'],
  },
  {
    id: 'order-import',
    name: '订单工作区',
    description: '复用人工或聊天创建的工作区、草稿、匹配、正式导入及真实回执。',
    version: '1.0.0',
    capabilities: ['跨页面工作区关联', '草稿编辑与匹配', '多文件幂等导入'],
  },
  {
    id: 'erp-page',
    name: 'ERP页面控制',
    description: '读取实际页面结构并操作ERP控件。原生业务API优先；操作后重新观察并核验。',
    version: '1.0.0',
    capabilities: [
      '页面/表格/表单/弹窗感知',
      '导航、点击、输入、选择、滚动和提交',
      '操作反馈与原服务核验；连接独立ERP浏览器后支持真实截图、坐标、键盘和附件上传；不控制Windows',
    ],
  },
  {
    id: 'task-ledger',
    name: '持久任务',
    description: '保存步骤和成功回执，中断后核验并继续。',
    version: '1.0.0',
    capabilities: ['计划与恢复', '幂等及结果核验'],
  },
  {
    id: 'attachment-reader',
    name: '隔离附件阅读',
    description: '阅读当前账号和会话的附件，不从附件获取业务授权。',
    version: '1.0.0',
    capabilities: ['附件阅读'],
  },
];
export function builtinPluginFor(name: string) {
  return name.startsWith('page.') || name.startsWith('browser.') || name === 'ui.open'
    ? 'erp-page'
    : name.startsWith('order_import.') || name === 'management.workspaces'
      ? 'order-import'
      : name.startsWith('task.')
        ? 'task-ledger'
        : name === 'attachments.read'
          ? 'attachment-reader'
          : 'erp-business';
}
