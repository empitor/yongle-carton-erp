// 只管：把各处的工具定义按固定顺序拼成工具目录。顺序决定注册表视图和系统提示词里工具的先后，新工具加在末尾。
import { financeReadTools } from '../../shared/finance/index.js';
import { promptTools } from './prompt-edit.js';
import { extraToolDefinitions } from './extra-tools.js';
import { arrivalTools } from './tools/arrivals.js';
import { correctionTools } from './tools/corrections.js';
import { documentInboxTools } from './tools/documents-inbox.js';
import { flowDocTools } from './tools/flow-docs.js';
import { managementTools } from './tools/management.js';
import { orderBatchTools } from './tools/order-batch.js';
import { orderImportTools } from './tools/order-import.js';
import { overviewTools } from './tools/overview.js';
import { pageToolDefinitions } from './tools/page.js';
import { planningTools } from './tools/planning.js';
import { recordLifecycleTools } from './tools/records-lifecycle.js';
import { recordReadTools } from './tools/records-read.js';
import { recordSaveTools } from './tools/records-save.js';
import { sessionTools } from './tools/session.js';
import { systemTools } from './tools/system.js';
import { historyTools } from './tools/history.js';
import { aiStatusTools } from './tools/ai-status.js';
import { jobsTools } from './tools/jobs.js';
import { adminViewTools } from './tools/admin-view.js';
import { guideTools } from './tools/guide.js';
import { diagnosticsTools } from './tools/diagnostics.js';
import { sourceTools } from './tools/source.js';
import { webTools } from './tools/web.js';
import { memoryTools } from './tools/memory.js';
import type { ToolDefinition } from './tools/define.js';

const order: string[] = [
  ...financeReadTools,
  'marks.list', 'inbox.list', 'inbox.set_status', 'documents.templates', 'flow.daily',
  'documents.preview', 'documents.status', 'documents.export', 'delivery.plan', 'production.plan',
  'order_batch.draft', 'order_batch.list', 'order_batch.get', 'order_batch.schedule', 'order_batch.receive',
  'arrival.records', 'purchase_return.returnable',
  'purchase_return.create', 'purchase_return.reverse',
  'delivery.mark_delivered', 'flow.schedule', 'inventory.batches',
  'prompts.get', 'prompts.propose',
  'page.observe',
  'management.delete_preview', 'records.delete', 'management.workspaces', 'management.execute',
  'management.reset', 'management.context', 'chat.list',
  'chat.delete', 'order_import.list', 'order_import.from_inbox', 'order_import.attach',
  'order_import.start', 'order_import.get', 'order_import.select',
  'order_import.edit', 'order_import.match', 'order_import.preview', 'order_import.execute',
  'order_import.retry', 'order_import.undo', 'system.status', 'system.check', 'system.backup',
  'management.reset_preview', 'marks.add', 'marks.remove', 'inbox.add',
  'arrival.recognize', 'ui.open', 'overview.get', 'records.summarize', 'records.search',
  'records.get', 'records.propose_save', 'records.propose_batch_lifecycle', 'records.propose_lifecycle',
  'flow.propose_cancel', 'inventory.propose_movement', 'flow.propose_production_completion',
  'flow.propose_confirmation', 'flow.propose_reversal',
  // 排查问题用的只读工具（2026-11-13 加）
  'history.records', 'ai.status', 'jobs.status', 'exports.list', 'settings.view', 'accounts.list', 'guide.read',
  'diagnostics.errors', 'logs.read', 'accounts.events', 'source.search', 'source.read',
  // 联网（自己的工具，不用模型内置的）
  'web.search', 'web.read',
  // 长期记忆（按账号）
  'memory.search', 'memory.save', 'memory.update', 'memory.forget', 'memory.auto',
  // 改已生效的单据：更正（撤销原单、出替代单）和改说明
  'arrival.correct', 'delivery.correct', 'production.correct', 'flow.edit_info',
];
const all: ToolDefinition[] = [
  ...overviewTools,
  ...documentInboxTools,
  ...flowDocTools,
  ...planningTools,
  ...orderBatchTools,
  ...arrivalTools,
  ...correctionTools,
  ...managementTools,
  ...recordReadTools,
  ...recordSaveTools,
  ...recordLifecycleTools,
  ...sessionTools,
  ...orderImportTools,
  ...systemTools,
  ...extraToolDefinitions,
  ...promptTools,
  ...pageToolDefinitions,
  ...historyTools,
  ...aiStatusTools,
  ...jobsTools,
  ...adminViewTools,
  ...guideTools,
  ...diagnosticsTools,
  ...sourceTools,
  ...webTools,
  ...memoryTools,
];
const byName = new Map(all.map((t) => [t.name, t]));
if (byName.size !== all.length || order.length !== all.length || order.some((name) => !byName.has(name)))
  throw new Error('工具目录的顺序表和各处的定义对不上（重名、缺了或多了）。');
/** 完整定义（说明、参数结构、校验和 tools/ 下的执行函数），注册表和外壳 tools.ts 用。 */
export const toolDefinitions = order.map((name) => {
  const definition = byName.get(name);
  if (!definition) throw new Error('工具目录的顺序表里有没定义的工具：' + name);
  return definition;
});
/** 只看名字、说明和风险的目录（不带参数结构和执行函数）。 */
export const toolCatalog = toolDefinitions.map(({ name, description, risk }) => ({ name, description, risk }));
