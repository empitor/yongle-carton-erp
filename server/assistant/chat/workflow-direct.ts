// 流程类工具里不算写入、直接执行的：只读的、只动这次对话里交来的识别结果的、只花模型费用的（新识别一份文件）。
// 每个都登记在这里并写明为什么不用确认；算写入的在 workflow-cards.ts。
// does：这一轮“服务器实际做了什么”那一行里怎么写（可以按执行结果写）；不给就按查询算。
import { AppError } from '../../core/index.js';
import { BusinessDocuments } from '../../documents/index.js';
import { importStateLabel } from '../../../shared/import/index.js';
import { memoryExecutors } from '../tools/memory.js';
import type { WorkflowContext } from '../order-import-state.js';
import type { ChatServices } from './run-state.js';
import { exportArgs } from './workflow-args.js';
import { field } from './result-fields.js';

/** args：按命令的结构校验过的参数 */
type Run = (svc: ChatServices, ctx: WorkflowContext, args: unknown, name: string) => unknown;
type Direct = { run: Run; does?: string | ((result: unknown) => string) };

/** 等浏览器把导出的文件下载完、交回执：最多等这么多次，每次隔这么久 */
const DELIVERY_POLLS = 60;
const DELIVERY_POLL_MS = 100;

const orderImport: Run = (svc, ctx, args, name) => {
  if (!svc.orderWorkflow) throw new AppError('AI 导入没有接上，这件事现在办不了。', 503);
  return svc.orderWorkflow.call(name, args, ctx);
};
const extra: Run = (svc, ctx, args, name) => svc.extras.call(name, args, ctx);
/** 长期记忆的记、改、忘、开关：回复下面那一行照执行结果写（“已记住：……”“已改记忆：改之前 → 改之后”） */
const memory: Direct = {
  run: (svc, ctx, args, name) => memoryExecutors(svc.registry.memory)[name](args, ctx.check()),
  does: (result) => String(field(result, 'message')),
};

export const WORKFLOW_DIRECT: Record<string, Direct> = {
  // 只读
  'order_import.list': { run: orderImport },
  'order_import.get': { run: orderImport },
  'order_import.preview': { run: orderImport },
  // 只换这个会话里“当前是哪份识别任务”、把已有工作区关联进会话：不复制、不识别、不改业务数据
  'order_import.select': { run: orderImport },
  'order_import.attach': { run: orderImport },
  // 识别：花模型费用，只生成识别结果，不进业务表（重试只对没识别成的那份；把已有工作区改成到货单再识别要出卡片）
  'order_import.start': {
    run: orderImport,
    // 按服务器记下的“这次真调了模型的份数”写，不看回执文字；没调模型的（已有结果、上次失败或中断）逐份原因在回执里
    does: (result) => (Number(field(result, 'recognizedCount')) > 0 ? '识别订单文件' : '没有重新识别订单文件'),
  },
  'order_import.retry': { run: orderImport, does: '重新识别订单文件' },
  'arrival.recognize': { run: extra, does: '识别到货单' },
  // 改识别结果、匹配档案、撤回修改：只动识别结果这份待核对的东西，不是业务数据，能撤回；
  // 正式导入那张卡片会把全部内容给人看，人点了才进业务表。只限这次对话里用户自己交来的那几份，动别的出卡片（workflow-cards.ts）
  'order_import.edit': { run: orderImport, does: '改识别结果（还没导入）' },
  'order_import.match': { run: orderImport, does: '给识别结果匹配档案（还没导入）' },
  'order_import.undo': { run: orderImport, does: '撤回识别结果的上一次修改' },
  // 长期记忆：不出确认卡片。用户定的——长期记忆照一般 AI 助手的做法，从对话里自己记、自己改；记了什么在回复下面标出来，
  // “更多 → 记忆”里看得见、能改、能删，自动记忆能关。它改变不了确认和权限，带给模型时写明“可能不准”（memory-rules.ts）
  'memory.save': memory,
  'memory.update': memory,
  'memory.forget': memory,
  'memory.auto': memory,
  // 只列出识别工作区（归档、恢复、复制、删除出卡片，见 workflow-cards.ts）。在用的每份带写好的状态叫法（和 AI 导入页同一份），
  // 不带“有没有识别结果”的英文字段，免得模型照字段说成别的词
  'management.workspaces': {
    run: (svc) => {
      if (!svc.orderWorkflow) throw new AppError('AI 导入没有接上，这件事现在办不了。', 503);
      const lists = svc.orderWorkflow.imports.workspaceLists();
      const active = lists.active.map(({ hasDraft, ...w }) => ({ ...w, state: importStateLabel({ ...w, hasDraft }) }));
      return { ...lists, active, message: '已查询实际识别工作区' };
    },
  },
  // 不带“交付后标记出库/已订货”的导出：只生成文件给浏览器下载，单据状态不变
  'documents.export': {
    does: '导出单据文件（单据状态不变）',
    run: async (svc, ctx, args) => {
      const documents = new BusinessDocuments(svc.store);
      // 导出服务的回执（单据导出模块给的样子，这里只取导出编号）
      const file: unknown = await documents.generate(exportArgs(svc.store, args, ctx.check()), ctx.check());
      ctx.emit('effect', { type: 'download', file });
      const exportId = String(field(file, 'exportId'));
      for (let i = 0; i < DELIVERY_POLLS; i++) {
        const status: unknown = documents.status(exportId, ctx.check());
        if (field(status, 'completedAt')) return status;
        await new Promise((resolve) => setTimeout(resolve, DELIVERY_POLL_MS));
      }
      const last: unknown = documents.status(exportId, ctx.check());
      return last;
    },
  },
};
