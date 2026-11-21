import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../core/index.js';
import type { Actor } from '../core/index.js';
import type { ImportManager } from '../import/index.js';
import { MarkService } from '../business/index.js';
import type { ReceiptAi } from '../import/index.js';
import type { AssistantAttachments } from './attachments.js';
import type { WorkflowContext } from './order-import-state.js';
import { AppError } from '../core/index.js';
import { audit } from '../core/index.js';
import { InboxService } from '../inbox/index.js';
import { prepareArrivalRecognition } from '../import/index.js';
import { resetPreview, systemBackup, systemCheck, systemStatus, systemTools, type BackupSettings } from './tools/system.js';
import { positive, uuid } from './tools/context.js';

/** 唛头标题最多几个字 */
const MARK_TITLE_MAX = 200;
/** 放进收件箱的一段文字最多几个字 */
const INBOX_TEXT_MAX = 20000;

export const extraToolDefinitions = [
  {
    name: 'marks.add',
    description: '把会话附件里的唛头文件挂到指定产品下，不识别；用户没说清是哪个产品先问。',
    arguments: { productId: 1, attachmentId: '附件ID，只有一份时可省略', title: '可选标题' },
    risk: 'workflow',
    schema: z.strictObject({
      productId: positive,
      attachmentId: uuid.optional(),
      title: z.string().trim().max(MARK_TITLE_MAX).optional(),
    }),
  },
  {
    name: 'marks.remove',
    description:
      '从产品上移除一份唛头，不影响产品和订单；先 marks.list 拿 id 和 version。',
    arguments: { id: 1, expectedVersion: 1 },
    risk: 'workflow',
    schema: z.strictObject({ id: positive, expectedVersion: positive }),
  },
  {
    name: 'inbox.add',
    description:
      '把一段文字或会话附件放进收件箱，不建业务单据；text 和 attachmentId 给一个。',
    arguments: { text: '要记下的文字', attachmentId: '附件ID' },
    risk: 'workflow',
    schema: z.strictObject({
      text: z.string().trim().min(1).max(INBOX_TEXT_MAX).optional(),
      attachmentId: uuid.optional(),
    }),
  },
  {
    name: 'arrival.recognize',
    description:
      '识别供应商送货单（附件或工作区），存为到货识别结果，不入库。登记到货要先找到订货单（order_batch.list）、用户说了验收结果再用 order_batch.receive；不挂采购单的货用 records.propose_save 存到货单。',
    arguments: { attachmentId: '当前会话附件ID，只有一份时可省略', workspaceId: '已有工作区ID，可省略', force: false },
    risk: 'workflow',
    schema: z.strictObject({
      attachmentId: uuid.optional(),
      workspaceId: uuid.optional(),
      force: z.boolean().optional(),
    }),
  },
];
const names = new Set([...systemTools, ...extraToolDefinitions].map((t) => t.name));

/** 系统维护、唛头、收件箱和到货识别的助手工具。都复用页面用的原服务，权限和审计不另开一套。 */
export class AssistantExtraTools {
  readonly store: Store;
  readonly attachments: AssistantAttachments;
  readonly marks: MarkService;
  readonly receiptAi: ReceiptAi;
  readonly imports: ImportManager;
  readonly backup: BackupSettings;
  /** 正在备份（tools/system.ts 的 systemBackup 改写），所以不是 private。 */
  backingUp = false;
  /** 唛头服务自己建（只用业务库）；别的都是建助手时给的 */
  constructor(deps: {
    store: Store;
    attachments: AssistantAttachments;
    receiptAi: ReceiptAi;
    imports: ImportManager;
    backup: BackupSettings;
  }) {
    this.store = deps.store;
    this.attachments = deps.attachments;
    this.receiptAi = deps.receiptAi;
    this.imports = deps.imports;
    this.backup = deps.backup;
    this.marks = new MarkService(deps.store);
  }
  handles(name: string) {
    return names.has(name);
  }
  /** 会话里的一份附件（只有一份时可以不说编号）；确认卡片写文件名也用它 */
  localFile(ctx: Pick<WorkflowContext, 'files' | 'check'>, attachmentId?: string) {
    const file = attachmentId
      ? ctx.files.find((f) => f.id === attachmentId)
      : ctx.files.length === 1
        ? ctx.files[0]
        : undefined;
    if (!file) throw new AppError('请说明是当前会话里的哪一份附件。');
    return this.attachments.file(file.id, ctx.check());
  }
  /** 只读工具 */
  read(name: string, raw: unknown, actor: Actor) {
    if (name === 'system.status') return systemStatus(this);
    if (name === 'system.check') return systemCheck(this);
    if (name === 'management.reset_preview') return resetPreview(this, raw, actor);
    throw new AppError('工具不是只读工具：' + name, 400);
  }
  /** 会写入或调用模型的工具 */
  async call(name: string, raw: unknown, ctx: WorkflowContext) {
    if (name === 'system.backup') return systemBackup(this, ctx);
    if (name === 'inbox.add') return this.addToInbox(raw, ctx);
    if (name === 'arrival.recognize') return this.recognizeArrival(raw, ctx);
    if (name === 'marks.add') return this.addMark(raw, ctx);
    if (name === 'marks.remove') return this.removeMark(raw, ctx);
    throw new AppError('未注册的工具：' + name, 400);
  }
  private addToInbox(raw: unknown, ctx: WorkflowContext) {
    const actor = ctx.check();
    const v = z
      .object({ text: z.string().trim().min(1).max(INBOX_TEXT_MAX).optional(), attachmentId: z.uuid().optional() })
      .parse(raw);
    if (!!v.text === !!v.attachmentId && !(ctx.files.length === 1 && !v.text))
      throw new AppError('text 和 attachmentId 给一个。');
    const inbox = new InboxService(this.store);
    const base = { channel: 'manual' as const, externalId: randomUUID(), receivedAt: new Date().toISOString() };
    const item = v.text ? inbox.ingest({ ...base, kind: 'text', text: v.text }) : this.inboxFile(inbox, base, ctx, v.attachmentId);
    audit(this.store, actor, { action: 'inbox-add', entity: 'inbox_item', id: item.id, document: {} });
    return { id: item.id, status: item.status, version: item.version, message: '已放进收件箱。' };
  }
  /** 会话里的一份附件放进收件箱：图片按图片收，别的按文件收 */
  private inboxFile(inbox: InboxService, base: { channel: 'manual'; externalId: string; receivedAt: string }, ctx: WorkflowContext, attachmentId?: string) {
    const file = this.localFile(ctx, attachmentId);
    const mime = file.meta.mime || 'application/octet-stream';
    return inbox.ingest({
      ...base,
      kind: mime.startsWith('image/') ? 'image' : 'file',
      file: { name: file.meta.name, mime, bytes: file.bytes },
    });
  }
  private async recognizeArrival(raw: unknown, ctx: WorkflowContext) {
    const manager = this.imports;
    const receiptAi = this.receiptAi;
    const actor = ctx.check();
    const v = z
      .object({
        attachmentId: z.uuid().optional(),
        workspaceId: z.uuid().optional(),
        force: z.boolean().default(false),
      })
      .parse(raw);
    const workspaceId = v.workspaceId || (await this.uploadArrival(manager, ctx, v.attachmentId));
    const before = manager.get(workspaceId);
    // 已有工作区换类型走 setMode：到货单已确认或取消的会被拒绝。
    if (before.mode !== 'arrival')
      manager.setMode(workspaceId, { expectedRevision: before.revision, mode: 'arrival' });
    const startedAt = Date.now();
    const workspace = manager.get(workspaceId);
    const { source } = await prepareArrivalRecognition(manager, receiptAi, workspaceId, actor);
    const stop = () => receiptAi.abort(source.id);
    ctx.signal.addEventListener('abort', stop);
    try {
      ctx.consumeModel?.();
      const result =
        source.result && !v.force
          ? source
          : await receiptAi.analyze(
              source.id,
              { force: v.force },
              ctx.check(),
            );
      return {
        workspaceId,
        fileName: workspace.fileName,
        recognized: result.result,
        url: '#ai-import?workspace=' + workspaceId,
        message: '到货单识别完成，还没有入库。',
        next: '查到对应采购单，把识别内容告诉用户；用户说了验收结果再登记。',
      };
    } catch (error) {
      manager.recordFailure(error, workspace, {
        operation: 'analyze',
        stream: false,
        stage: 'supplier-arrival',
        startedAt,
        actor,
      });
      throw error;
    } finally {
      ctx.signal.removeEventListener('abort', stop);
    }
  }
  /** 会话里的附件存成到货识别的工作区，返回工作区编号 */
  private async uploadArrival(manager: ImportManager, ctx: WorkflowContext, attachmentId?: string) {
    const original = this.localFile(ctx, attachmentId);
    return (await manager.upload(original.bytes, original.meta.name, true, 'arrival')).workspace.id;
  }
  private addMark(raw: unknown, ctx: WorkflowContext) {
    const actor = ctx.check();
    const v = z
      .object({
        productId: z.number().int().positive(),
        attachmentId: z.uuid().optional(),
        title: z.string().trim().max(MARK_TITLE_MAX).optional(),
      })
      .parse(raw);
    const file = this.localFile(ctx, v.attachmentId);
    const mime = file.meta.mime || 'application/octet-stream';
    if (!/^(?:application\/pdf|image\/(?:png|jpeg|webp))$/.test(mime))
      throw new AppError('唛头只支持 PDF 和 PNG、JPG、WEBP 图片。', 415);
    const mark = this.marks.add(
      {
        productId: v.productId,
        bytes: file.bytes,
        name: file.meta.name,
        mime,
        title: v.title || '',
        sourceKind: 'assistant',
      },
      actor,
    );
    return { id: mark.id, productId: v.productId, fileName: file.meta.name, verified: true, message: '原文件已挂到产品下。' };
  }
  private removeMark(raw: unknown, ctx: WorkflowContext) {
    const actor = ctx.check();
    const v = z.object({ id: z.number().int().positive(), expectedVersion: z.number().int().positive() }).parse(raw);
    const before = this.marks.get(v.id);
    this.marks.remove(v.id, { expectedVersion: v.expectedVersion }, actor);
    return {
      id: v.id,
      productId: before.productId,
      fileName: before.fileName,
      verified: true,
      message: '已从产品上移除这份唛头，产品和订单没有变化。',
    };
  }

}
