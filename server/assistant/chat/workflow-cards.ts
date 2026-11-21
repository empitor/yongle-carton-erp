// 流程类工具里算写入的（改业务数据、删东西、改提示词）：登记在这张固定的表里，和用户说了什么无关。
// 登记了的只出确认卡片：card() 由服务器算出卡片上给人看的内容（summary）和确认时原样执行的参数（args）；
// 人点确认后 run() 按存下来的参数执行。业务类工具（有方案生成器的）一律出卡片，不在这里，见 tool-step.ts。
// 不算写入的流程类工具在 workflow-direct.ts；流程类工具两边都没登记，tests/assistant-boundaries.test.ts 会拦。
import type { Store } from '../../core/index.js';
import { BusinessDocuments } from '../../documents/index.js';
import { FlowService } from '../../flow/index.js';
import { InboxService } from '../../inbox/index.js';
import { executeImports, importCard } from '../order-import-card.js';
import type { WorkflowContext } from '../order-import-state.js';
import type { ChatServices } from './run-state.js';
import { field } from './result-fields.js';
import {
  INBOX_TEXT_CHARS,
  draftEditView,
  exportArgs,
  exportView,
  fieldNames,
  fromInboxView,
  importRequest,
  inboxAddView,
  markAddView,
  markRemoveView,
  mergedIds,
  recognizeView,
  storedImports,
  taskIdOf,
} from './workflow-args.js';

export type CardLine = { label: string; value: string };
export type WorkflowCard = {
  label: string;
  summary: CardLine[];
  warnings?: string[];
  /** 确认时原样执行的参数；不给就是模型传的那一份 */
  args?: Record<string, unknown>;
};
/**
 * when 拿到的是模型传的参数（判断状态行写什么时还没按命令的结构校验，只看几个开关）；
 * card 拿到的是按命令的结构校验过的参数；run 拿到的是卡片存下来的参数（card 给了 args 就是它）。
 * 各自按下面的“看的是哪几项”取字段，交给服务的照旧是原来那一份。
 */
type Entry = {
  /** 只有这种情况才算写入（比如导出带不带“交付后标记出库”、改的识别结果是不是这次对话带进来的）；不给就是一律算 */
  when?: (args: unknown, svc: ChatServices, ctx: WorkflowContext) => boolean;
} & (
  | {
      card: (svc: ChatServices, ctx: WorkflowContext, args: unknown) => WorkflowCard | Promise<WorkflowCard>;
      run: (svc: ChatServices, ctx: WorkflowContext, args: unknown) => unknown;
    }
  /** 卡片和执行都在业务类的写入表里（tools.ts），和业务类工具一样出卡片 */
  | { planned: true }
);

const productName = (store: Store, id: number | undefined) =>
  (id === undefined ? undefined : store.products(true, [id])[0]?.name) ?? '编号 ' + id;
/** 改识别结果的三个命令各自的卡片标题 */
const DRAFT_EDITS: Record<string, string> = {
  'order_import.edit': '改识别结果',
  'order_import.match': '给识别结果匹配档案',
  'order_import.undo': '撤回识别结果的上一次修改',
};
/** 动的不是这次对话里交来的识别结果时那张卡片：写明是哪份文件、要改成什么 */
function draftEditCard(svc: ChatServices, ctx: WorkflowContext, name: string, raw: unknown): WorkflowCard {
  const a = draftEditView.parse(raw);
  const wf = svc.orderWorkflow;
  const w = wf.imports.get(wf.selected(ctx, a.taskId).task.workspaceId);
  const rowOf = (lineId: string) => (w.draft?.lines.findIndex((l) => l.id === lineId) ?? -1) + 1;
  const changes: CardLine[] =
    name === 'order_import.edit'
      ? (a.operations ?? []).map((op) => ({
          label: (op.op === 'set-header' ? '表头 ' : '第 ' + rowOf(op.lineId ?? '') + ' 行 ') + (fieldNames[op.field] ?? op.field),
          value: '改成 ' + (op.value ?? '空'),
        }))
      : name === 'order_import.undo'
        ? [{ label: '改动', value: '撤回最近的一次修改' }]
        : a.customerId
          ? [{ label: '客户', value: '配成 ' + (svc.store.customer(a.customerId)?.name ?? '编号 ' + a.customerId) }]
          : a.line
            ? [{ label: '第 ' + a.line + ' 行产品', value: a.createNew ? '新建档案' : '配成 ' + (a.productCode ?? productName(svc.store, a.productId)) }]
            : [{ label: '客户', value: a.createNew ? '新建档案' : '按名称自动匹配' }];
  return {
    label: DRAFT_EDITS[name] + '：' + w.fileName,
    summary: [{ label: '识别结果', value: w.fileName + '（不是这次对话里交来的）' }, ...changes],
    warnings: ['这份识别结果全员共用，改了别人也会看到。'],
  };
}

export const WORKFLOW_WRITES: Record<string, Entry> = {
  // 带 markShipped（交付后出库扣库存）、markOrdered（交付后标已订货）的导出：文件下载完成后单据状态就变
  'documents.export': {
    when: (a) => !!(field(a, 'markShipped') || field(a, 'markOrdered')),
    card: async (svc, ctx, raw) => {
      const a = exportView.parse(raw);
      const delivery = a.kind === 'delivery';
      const ids = mergedIds(a);
      // 先按模板排一遍版（只看不落库）：排不下、单据不对的现在就把原因交给模型，不出一张确认了也办不成的卡片
      const template = a.templateId ? { templateId: a.templateId } : {};
      await new BusinessDocuments(svc.store).previewFile(
        delivery
          ? { kind: 'delivery', id: a.id, shipping: true, ...template }
          : { kind: 'purchase', purchaseIds: ids, schedule: field(exportArgs(svc.store, raw, ctx.check()), 'schedule'), ...template },
        ctx.check(),
      );
      // 动的是哪张、每行多少：和业务类卡片同一份写法；出库的在回滚点里按文件交付后同一个出库函数试一遍，写明库存从多少变成多少
      const actor = ctx.check();
      const cards = delivery
        ? [svc.tools.recordCard('delivery', a.id, actor, () => new FlowService(svc.store).shipDelivery(a.id, a.expectedVersion, actor))]
        : ids.map((id) => svc.tools.recordCard('purchases', id, actor));
      const titles = cards.map((c) => c.title);
      return {
        label: (delivery ? '导出送货单并出库：' : '导出订货单并标记已订货：') + titles.join('、'),
        summary: [
          { label: delivery ? '送货单' : '采购单', value: titles.join('、') },
          { label: '文件下载完成后', value: delivery ? '送货单出库，扣成品库存' : '采购单标记为已订货（待到货）' },
          ...cards.flatMap((c) => c.lines.map((l) => (cards.length > 1 ? { label: c.title + ' ' + l.label, value: l.value } : l))),
          ...(a.schedule ?? []).map((s) => ({
            label: '到货安排 第 ' + s.row + ' 行',
            value: s.quantity + (s.dueDate ? '，' + s.dueDate : ''),
          })),
        ],
      };
    },
    // 生成文件交给浏览器下载；下载完成后浏览器按和人工一样的接口交回执，单据状态那时才改
    run: async (svc, ctx, a) => {
      // 导出服务的回执（单据导出模块给的样子，这里只取导出编号）
      const file: unknown = await new BusinessDocuments(svc.store).generate(exportArgs(svc.store, a, ctx.check()), ctx.check());
      return { file, exportId: field(file, 'exportId'), message: '文件已生成，等浏览器下载完成后单据状态才会改。' };
    },
  },
  'prompts.propose': {
    card: (svc, ctx, a) => {
      const change = svc.promptEdit.propose(a, ctx.check());
      return {
        label: '修改提示词：' + svc.promptEdit.moduleName(change.module) + ' → ' + change.presetName + ' → ' + change.entryName,
        summary: [
          { label: '改之前', value: change.before },
          { label: '改之后', value: change.content },
        ],
        warnings: ['提示词全员共用，保存后所有人的助手都按新的来。'],
        args: change,
      };
    },
    run: (svc, ctx, a) => svc.promptEdit.save(a, ctx.check()),
  },
  'chat.delete': {
    card: (svc, ctx, a) => {
      const targets = svc.conversations.deletionTargets(a, ctx.threadId, ctx.check());
      return {
        label: '删除聊天记录：' + (targets.threadIds.length ? targets.threadIds.length + ' 个会话' : '') + (targets.includeCurrent ? (targets.threadIds.length ? '，并' : '') + '清空当前会话' : ''),
        summary: [
          ...targets.titles.map((title, i) => ({ label: '会话 ' + (i + 1), value: title })),
          ...(targets.includeCurrent ? [{ label: '当前会话', value: '记录和附件全部清空' }] : []),
        ],
        warnings: ['聊天记录删了找不回；业务数据不受影响。'],
        args: { threadIds: targets.threadIds, includeCurrent: targets.includeCurrent },
      };
    },
    run: (svc, ctx, a) => svc.conversations.deleteThreads(a, ctx.threadId, ctx.check()),
  },
  // 正式导入：一份或几份，一张卡片列全
  'order_import.execute': {
    card: (svc, ctx, a) => importCard(svc.orderWorkflow, ctx, importRequest.parse(a)),
    run: (svc, ctx, a) => executeImports(svc.orderWorkflow, ctx, storedImports.parse(a).imports),
  },
  // 改识别结果、匹配档案、撤回修改：这次对话里用户自己交来的那几份（上传后识别的、从收件箱转来的）直接改（workflow-direct.ts）；
  // 动别的识别结果（关联进来的、别人待导入的）出卡片。按这份东西是不是这次对话带进来的判断，不看用户说了什么
  ...Object.fromEntries(
    Object.keys(DRAFT_EDITS).map((name): [string, Entry] => [
      name,
      {
        when: (a, svc, ctx) => !svc.orderWorkflow.ownTask(ctx, taskIdOf(a)),
        card: (svc, ctx, a) => draftEditCard(svc, ctx, name, a),
        run: (svc, ctx, a) => svc.orderWorkflow.call(name, a, ctx),
      },
    ]),
  ),
  // 识别工作区的归档、恢复、复制、删除（删除的卡片按删除画，plan-rules.ts 的 destructivePlan）；只列出不算
  'management.workspaces': { when: (a) => field(a, 'action') !== 'list', planned: true },
  // 把已有的识别工作区当到货单重新识别：会改那份工作区的类型和识别结果（传附件的只是新识别一份，不算）
  'arrival.recognize': {
    when: (a) => !!field(a, 'workspaceId'),
    card: (svc, _ctx, raw) => {
      const a = recognizeView.parse(raw);
      const w = svc.orderWorkflow.imports.get(a.workspaceId);
      return {
        label: '把识别工作区当到货单识别：' + w.fileName,
        summary: [
          { label: '文件', value: w.fileName },
          { label: '改动', value: '类型改成到货单，按到货单' + (a.force ? '重新' : '') + '识别（要花模型费用）' },
        ],
      };
    },
    run: (svc, ctx, a) => svc.extras.call('arrival.recognize', a, ctx),
  },
  // 收件箱的条目转进 AI 导入：条目的状态会变（别人也看得到）
  'order_import.from_inbox': {
    card: (svc, ctx, raw) => {
      ctx.check();
      const a = fromInboxView.parse(raw);
      const item = new InboxService(svc.store).get(a.inboxId);
      return {
        label: '把收件箱第 ' + a.inboxId + ' 条转进 AI 导入',
        summary: [
          { label: '收件箱条目', value: item.fileName || String(item.text ?? '').slice(0, INBOX_TEXT_CHARS) || '第 ' + a.inboxId + ' 条' },
          { label: '转成', value: a.recognitionType === 'arrival' ? '到货单（还不识别）' : '客户订单（还不识别）' },
        ],
      };
    },
    run: (svc, ctx, a) => svc.orderWorkflow.call('order_import.from_inbox', a, ctx),
  },
  'marks.add': {
    card: (svc, ctx, raw) => {
      const a = markAddView.parse(raw);
      const file = svc.extras.localFile(ctx, a.attachmentId);
      return {
        label: '给产品挂唛头：' + productName(svc.store, a.productId),
        summary: [
          { label: '产品', value: productName(svc.store, a.productId) },
          { label: '文件', value: file.meta.name },
          ...(a.title ? [{ label: '标题', value: a.title }] : []),
        ],
        // 没说是哪份附件时，这里定下来，确认时就挂这一份
        args: { ...a, attachmentId: file.meta.id },
      };
    },
    run: (svc, ctx, a) => svc.extras.call('marks.add', a, ctx),
  },
  'marks.remove': {
    card: (svc, _ctx, raw) => {
      const mark = svc.extras.marks.get(markRemoveView.parse(raw).id);
      return {
        label: '移除唛头：' + mark.fileName,
        summary: [
          { label: '产品', value: productName(svc.store, mark.productId) },
          { label: '唛头文件', value: mark.fileName },
        ],
        warnings: ['只从产品上拿掉这份唛头，产品和订单不变。'],
      };
    },
    run: (svc, ctx, a) => svc.extras.call('marks.remove', a, ctx),
  },
  // 备份：每次多出一份完整备份，手动做的不会自动清理
  'system.backup': {
    card: (_svc, ctx) => {
      ctx.check();
      return {
        label: '马上做一次完整备份',
        summary: [
          { label: '会多出', value: '一份完整备份：整个数据目录（业务库、附件、识别文件、设置），和每日自动备份内容一样' },
          { label: '放在', value: '备份目录；手动做的不会自动清理，多了要自己删' },
        ],
      };
    },
    run: (svc, ctx, a) => svc.extras.call('system.backup', a, ctx),
  },
  // 收件箱全员共用：放进去的东西别人也看得到
  'inbox.add': {
    card: (svc, ctx, raw) => {
      const { text, attachmentId } = inboxAddView.parse(raw);
      if (text) return { label: '放进收件箱：一段文字', summary: [{ label: '文字', value: text }], args: { text } };
      const file = svc.extras.localFile(ctx, attachmentId);
      return {
        label: '放进收件箱：' + file.meta.name,
        summary: [{ label: '文件', value: file.meta.name }],
        args: { attachmentId: file.meta.id },
      };
    },
    run: (svc, ctx, a) => svc.extras.call('inbox.add', a, ctx),
  },
};

/** 这次调用算不算流程类的写入；算就返回登记。 */
export function workflowWrite(name: string, args: unknown, svc: ChatServices, ctx: WorkflowContext) {
  const entry = Object.hasOwn(WORKFLOW_WRITES, name) ? WORKFLOW_WRITES[name] : undefined;
  return entry && (!entry.when || entry.when(args ?? {}, svc, ctx)) ? entry : undefined;
}
