import type { Actor } from '../core/index.js';
import type { Permission } from '../../shared/core/index.js';
import type { ToolDefinition } from './tools/define.js';
/**
 * 工具分组：命令目录按组分小节，管理员能在“插件与工具”里整组停用。只有编号、名字和一句说明；
 * 每个工具归哪一组由 builtinPluginFor 按名字定，新工具不在表里就报错，加工具时补一行。
 */
export type PluginManifest = {
  id: string;
  name: string;
  description: string;
};
/** 注册表里的一条：目录里的定义（说明、参数结构、校验）加上类别、另要的权限，查记忆这类由注册表直接执行的带 execute */
export type PluginTool = Pick<ToolDefinition, 'name' | 'description' | 'risk' | 'schema' | 'check'> & {
  kind: 'read' | 'business' | 'workflow';
  permissions?: Permission[];
  execute?: (args: unknown, actor: Actor, context: unknown) => unknown;
};
export const builtinPlugins: PluginManifest[] = [
  { id: 'records', name: '记录查改删', description: '查、汇总、新建、修改、归档和删除业务记录，查修改历史和经营概况。' },
  { id: 'purchasing', name: '采购订货和到货', description: '订货单、到货登记、到货记录、更正到货和采购退货。' },
  { id: 'production-delivery', name: '生产和送货', description: '安排生产和送货、登记完工、核对入库出库、冲销、盘点和成品批次。' },
  { id: 'documents', name: '单据导出', description: '预览和导出采购订货单、送货单，查导出交付到哪一步。' },
  { id: 'finance', name: '财务', description: '查盈亏、应收应付、收付款、发票、凭证和报表，只读。' },
  { id: 'inbox-marks', name: '收件箱和唛头', description: '收件箱里外来的消息和文件，产品下挂的唛头。' },
  { id: 'order-import', name: 'AI 导入工作区', description: '识别客户订单和供应商送货单，改识别结果、匹配和正式导入。' },
  { id: 'erp-page', name: 'ERP页面', description: '看用户眼前的页面、打开指定的页面或记录。' },
  { id: 'assistant-memory', name: '长期记忆', description: '按账号记住用户自己说的偏好、说法和纠正。' },
  { id: 'chat-records', name: '聊天记录', description: '查看和删除当前账号自己的聊天会话。' },
  { id: 'diagnostics', name: '排查和设置', description: '出错记录、运行日志、程序代码、AI 接入、后台任务、设置、账号、使用说明和提示词。' },
  { id: 'web', name: '联网', description: '联网搜索和读公开网页。' },
  { id: 'system-maintenance', name: '系统维护', description: '系统状态、数据库体检、马上备份和一键清空。' },
];
/** 名字（或名字前缀，以点结尾）→ 组。按顺序找第一条对上的，具体名字写在前缀前面。 */
const groupOf: [string, string][] = [
  ['management.workspaces', 'order-import'],
  ['arrival.recognize', 'order-import'],
  ['order_import.', 'order-import'],
  ['management.reset', 'system-maintenance'],
  ['management.reset_preview', 'system-maintenance'],
  ['system.', 'system-maintenance'],
  ['management.', 'records'],
  ['records.', 'records'],
  ['history.records', 'records'],
  ['overview.get', 'records'],
  ['order_batch.', 'purchasing'],
  ['arrival.records', 'purchasing'],
  ['purchase_return.', 'purchasing'],
  ['arrival.correct', 'purchasing'],
  ['delivery.', 'production-delivery'],
  ['production.plan', 'production-delivery'],
  ['production.correct', 'production-delivery'],
  ['flow.', 'production-delivery'],
  ['inventory.', 'production-delivery'],
  ['documents.', 'documents'],
  ['exports.list', 'documents'],
  ['finance.', 'finance'],
  ['inbox.', 'inbox-marks'],
  ['marks.', 'inbox-marks'],
  ['page.', 'erp-page'],
  ['ui.open', 'erp-page'],
  ['memory.', 'assistant-memory'],
  ['chat.', 'chat-records'],
  ['web.', 'web'],
  ['diagnostics.', 'diagnostics'],
  ['logs.read', 'diagnostics'],
  ['source.', 'diagnostics'],
  ['ai.status', 'diagnostics'],
  ['jobs.status', 'diagnostics'],
  ['settings.view', 'diagnostics'],
  ['accounts.', 'diagnostics'],
  ['guide.read', 'diagnostics'],
  ['prompts.', 'diagnostics'],
];
export function builtinPluginFor(name: string) {
  const hit = groupOf.find(([key]) => (key.endsWith('.') ? name.startsWith(key) : name === key));
  if (!hit) throw new Error('工具没有分组：' + name + '（在 server/assistant/plugins.ts 的 groupOf 里补一行）');
  return hit[1];
}
