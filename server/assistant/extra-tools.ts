import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Store } from '../db.js';
import type { Actor } from '../auth.js';
import type { ImportManager } from '../import/manager.js';
import type { MarkImportService } from '../marks/mark-import.js';
import type { ReceiptAi } from '../flow/receipt-ai.js';
import type { AssistantAttachments } from './attachments.js';
import type { WorkflowContext } from './order-workflow.js';
import { ImportError } from '../import/errors.js';
import { audit } from '../business/management.js';
import { DevelopmentResetService, developmentResetScope } from '../business/development-reset.js';
import { InboxService } from '../inbox/service.js';
import { autoBackupFailure, createFullBackup } from '../backup.js';
import { prepareArrivalRecognition } from '../flow/arrival-recognition.js';
import { APP_VERSION } from '../../shared/version.js';
import { askedInChat } from './task-routing.js';

export type BackupSettings = {
  dataDir: string;
  backupRoot: string;
  extraFiles?: Record<string, string>;
};
const MARK_REMOVE =
  /(?:移除|删|去掉|取消|解绑|拿掉).{0,14}唛头|唛头.{0,14}(?:移除|删|去掉|取消|解绑|拿掉)/;

export const extraToolDefinitions = [
  {
    name: 'system.status',
    description:
      '查看系统状态：版本、数据库大小、主要记录数量、最近的备份和自动备份是否失败。仅本机最高管理员。',
    arguments: {},
    risk: 'read',
  },
  {
    name: 'system.check',
    description:
      '数据库体检：完整性、关联是否断开、有没有负库存。只读，不修改。仅本机最高管理员。',
    arguments: {},
    risk: 'read',
  },
  {
    name: 'system.backup',
    description:
      '马上做一次完整备份（业务库、账号、AI 工作区和原件、提示词、配置），和每日自动备份同样的内容。用户要求备份时调用。恢复备份要先停机，助手不能做，告诉用户运行 npm run restore。',
    arguments: {},
    risk: 'workflow',
  },
  {
    name: 'management.reset_preview',
    description:
      '查看一键清空会影响多少条数据，不删除任何东西。清空前先用它把数量告诉用户。scope 可选 business、ai-imports、all。',
    arguments: { scope: ['business', 'ai-imports', 'all'] },
    risk: 'read',
  },
  {
    name: 'marks.recognize',
    description:
      '识别唛头文件（附件或已有工作区），按料号、名称、尺寸对应产品；唯一对应上就把原文件挂到产品下，产品详情里可以预览。不产生订单、生产或库存。对不上时返回候选，告诉用户并让用户选，选定后用 marks.attach。',
    arguments: { attachmentId: '当前会话附件ID，只有一份时可省略', workspaceId: '已有工作区ID，可省略', force: false },
    risk: 'workflow',
  },
  {
    name: 'marks.attach',
    description:
      '用户选定产品后，把识别过的唛头原文件挂到产品下。choices 逐款给 key 和 productId；用户要新建产品传 newName，不要这一款传 skip。',
    arguments: { workspaceId: '工作区ID', choices: [{ key: 'p1-0', productId: 1 }] },
    risk: 'workflow',
  },
  {
    name: 'marks.add',
    description: '把当前会话的附件直接挂到指定产品下，不识别、不收费。用户已经说清楚是哪个产品时用。',
    arguments: { productId: 1, attachmentId: '附件ID，只有一份时可省略', title: '可选标题' },
    risk: 'workflow',
  },
  {
    name: 'marks.remove',
    description:
      '从产品上移除一份唛头。先 marks.list 查到 id 和 version。只有用户明确说要移除唛头才调用，不影响产品本身和订单。',
    arguments: { id: 1, expectedVersion: 1 },
    risk: 'workflow',
  },
  {
    name: 'inbox.add',
    description:
      '把一段文字或当前会话的附件放进收件箱，和页面上手动添加一样。不创建业务单据。text 和 attachmentId 给一个。',
    arguments: { text: '要记下的文字', attachmentId: '附件ID' },
    risk: 'workflow',
  },
  {
    name: 'arrival.recognize',
    description:
      '识别供应商送货单（附件、收件箱转来的工作区），返回供应商、单号、日期和每行数量，并保存为到货识别结果。不入库、不改采购。识别结果是草稿：查到采购单、用户说了验收结果后才用 arrival.receive 登记。',
    arguments: { attachmentId: '当前会话附件ID，只有一份时可省略', workspaceId: '已有工作区ID，可省略', force: false },
    risk: 'workflow',
  },
];
const names = new Set(extraToolDefinitions.map((t) => t.name));

/** 系统维护、唛头、收件箱和到货识别的助手工具。都复用页面用的原服务，权限和审计不另开一套。 */
export class AssistantExtraTools {
  marks?: MarkImportService;
  receiptAi?: ReceiptAi;
  imports?: ImportManager;
  backup?: BackupSettings;
  private backingUp = false;
  constructor(
    readonly store: Store,
    readonly attachments: AssistantAttachments,
  ) {}
  handles(name: string) {
    return names.has(name);
  }
  private localFile(ctx: WorkflowContext, attachmentId?: string) {
    const file = attachmentId
      ? ctx.files.find((f) => f.id === attachmentId)
      : ctx.files.length === 1
        ? ctx.files[0]
        : undefined;
    if (!file) throw new ImportError('请说明是当前会话里的哪一份附件。');
    return this.attachments.file(file.id, ctx.check());
  }
  private previousUserText(threadId: string) {
    const row = this.store.db
      .prepare(
        "SELECT text FROM assistant_messages WHERE thread_id=? AND role='user' ORDER BY rowid DESC LIMIT 1 OFFSET 1",
      )
      .get(threadId) as { text?: string } | undefined;
    return row?.text || '';
  }
  private importManager() {
    if (!this.imports) throw new ImportError('AI 导入服务未配置。', 503);
    return this.imports;
  }
  /** 只读工具 */
  read(name: string, raw: unknown, actor: Actor) {
    if (name === 'system.status') return this.status();
    if (name === 'system.check') return this.check();
    if (name === 'management.reset_preview') {
      const v = z.strictObject({ scope: z.enum(developmentResetScope) }).parse(raw);
      const service = new DevelopmentResetService(this.store);
      const preview = service.preview(v.scope, actor) as any;
      const total = Object.values(preview.tables || {}).reduce(
        (a: number, b: any) => a + Number(b),
        0,
      );
      const financeRows = v.scope === 'ai-imports' ? 0 : service.financeRows();
      return {
        scope: v.scope,
        total,
        ...(financeRows
          ? {
              financeRows,
              blocked:
                '财务里已有记录，助手不能执行这次清空，要到“系统维护”页面操作，那里会连财务一起清。',
            }
          : {}),
        nonEmpty: Object.fromEntries(
          Object.entries(preview.tables || {}).filter(([, n]) => Number(n) > 0),
        ),
        closedFinancePeriods: preview.finance?.closed?.length || 0,
        workspaces: v.scope === 'business' ? undefined : this.imports?.status().workspaces.length,
        message: '这只是预览，什么都没删。',
      };
    }
    throw new ImportError('工具不是只读工具：' + name, 400);
  }
  private count(table: string) {
    try {
      return Number(this.store.db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()!.n);
    } catch {
      return null;
    }
  }
  private backups() {
    const root = this.backup?.backupRoot;
    if (!root || !existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^(?:auto|full)-/.test(e.name) && !e.name.endsWith('.partial'))
      .map((e) => {
        const dir = join(root, e.name);
        let bytes: number | null = null;
        try {
          const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
          bytes = manifest.files.reduce((n: number, f: any) => n + Number(f.bytes || 0), 0);
        } catch {
          /* 清单读不了也要列出来，体积留空 */
        }
        return {
          name: e.name,
          kind: e.name.startsWith('auto-') ? '每日自动' : '手动',
          at: statSync(dir).mtime.toISOString(),
          megabytes: bytes === null ? null : Math.round((bytes / 1048576) * 10) / 10,
        };
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  }
  private status() {
    const db = this.store.db;
    const list = this.backups();
    return {
      version: APP_VERSION,
      databaseMegabytes:
        this.store.path === ':memory:' || !existsSync(this.store.path)
          ? null
          : Math.round((statSync(this.store.path).size / 1048576) * 10) / 10,
      schemaVersion: Number(
        db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version ?? 0,
      ),
      records: Object.fromEntries(
        ['customers', 'products', 'orders', 'suppliers', 'purchases', 'stock_movements', 'inbox_items', 'product_marks', 'assistant_threads'].map(
          (t) => [t, this.count(t)],
        ),
      ),
      backups: { total: list.length, latest: list.slice(0, 5), configured: !!this.backup },
      autoBackupFailure: autoBackupFailure(),
    };
  }
  private check() {
    const db = this.store.db;
    const integrity = (db.prepare('PRAGMA integrity_check').all() as any[]).map((r) =>
      String(r.integrity_check),
    );
    const brokenLinks = db.prepare('PRAGMA foreign_key_check').all().length;
    const negative = db
      .prepare(
        'SELECT i.name,i.unit,SUM(m.delta_units) AS units FROM stock_movements m JOIN stock_items i ON i.id=m.item_id GROUP BY m.item_id HAVING SUM(m.delta_units)<0 LIMIT 20',
      )
      .all() as { name: string; unit: string; units: number }[];
    const problems = [
      ...(integrity.length === 1 && integrity[0] === 'ok' ? [] : ['数据库完整性检查没通过']),
      ...(brokenLinks ? [brokenLinks + ' 处关联断开'] : []),
      ...negative.map((n) => n.name + ' 库存为负：' + n.units / 1000 + ' ' + n.unit),
    ];
    return {
      healthy: !problems.length,
      integrity: integrity.slice(0, 5),
      brokenLinks,
      negativeStock: negative.length,
      problems,
      message: problems.length ? '发现 ' + problems.length + ' 个问题。' : '数据库正常，没有发现问题。',
    };
  }
  /** 会写入或调用模型的工具 */
  async call(name: string, raw: any, ctx: WorkflowContext) {
    if (name === 'system.backup') return this.makeBackup(ctx);
    if (name === 'inbox.add') return this.addToInbox(raw, ctx);
    if (name === 'arrival.recognize') return this.recognizeArrival(raw, ctx);
    if (name === 'marks.add') return this.addMark(raw, ctx);
    if (name === 'marks.remove') return this.removeMark(raw, ctx);
    if (name === 'marks.recognize') return this.recognizeMark(raw, ctx);
    if (name === 'marks.attach') return this.attachMark(raw, ctx);
    throw new ImportError('未注册的工具：' + name, 400);
  }
  private async makeBackup(ctx: WorkflowContext) {
    const actor = ctx.check();
    if (!this.backup) throw new ImportError('这个实例没有配置备份目录。', 503);
    if (this.backingUp) throw new ImportError('已经有一个备份在进行中。', 409);
    this.backingUp = true;
    try {
      const result = await createFullBackup({ ...this.backup, prefix: 'full' });
      audit(this.store, actor, 'assistant', 'full-backup', 'system', null, {
        files: result.files,
        bytes: result.bytes,
      });
      return {
        name: result.dir.split(/[\\/]/).pop(),
        files: result.files,
        megabytes: Math.round((result.bytes / 1048576) * 10) / 10,
        verified: true,
        message: '完整备份已生成，共 ' + result.files + ' 个文件。',
      };
    } finally {
      this.backingUp = false;
    }
  }
  private addToInbox(raw: any, ctx: WorkflowContext) {
    const actor = ctx.check();
    const v = z
      .object({ text: z.string().trim().min(1).max(20000).optional(), attachmentId: z.string().uuid().optional() })
      .parse(raw);
    if (!!v.text === !!v.attachmentId && !(ctx.files.length === 1 && !v.text))
      throw new ImportError('text 和 attachmentId 给一个。');
    const inbox = new InboxService(this.store);
    const base = { channel: 'manual' as const, externalId: randomUUID(), receivedAt: new Date().toISOString() };
    let item: any;
    if (v.text) item = inbox.ingest({ ...base, kind: 'text', text: v.text });
    else {
      const file = this.localFile(ctx, v.attachmentId);
      const mime = file.meta.mime || 'application/octet-stream';
      item = inbox.ingest({
        ...base,
        kind: mime.startsWith('image/') ? 'image' : 'file',
        file: { name: file.meta.name, mime, bytes: file.bytes },
      });
    }
    audit(this.store, actor, 'assistant', 'inbox-add', 'inbox_item', item?.id ?? null, {});
    return { id: item?.id, status: item?.status, version: item?.version, message: '已放进收件箱。' };
  }
  private async recognizeArrival(raw: any, ctx: WorkflowContext) {
    const manager = this.importManager();
    if (!this.receiptAi) throw new ImportError('到货识别未配置。', 503);
    const receiptAi = this.receiptAi;
    const actor = ctx.check();
    const v = z
      .object({
        attachmentId: z.string().uuid().optional(),
        workspaceId: z.string().uuid().optional(),
        force: z.boolean().default(false),
      })
      .parse(raw);
    let workspaceId = v.workspaceId;
    if (!workspaceId) {
      const original = this.localFile(ctx, v.attachmentId);
      workspaceId = (await manager.upload(original.bytes, original.meta.name, true)).workspace.id;
    }
    const before = manager.get(workspaceId!);
    if (before.mode !== 'arrival')
      manager.setMode(workspaceId!, { expectedRevision: before.revision, mode: 'arrival' });
    const startedAt = Date.now();
    const workspace = manager.get(workspaceId!);
    // 外发给的是用户发这条消息时确认的模型；中途换了配置就停下重新确认。
    const { source, profile } = await prepareArrivalRecognition(manager, receiptAi, workspaceId!, actor, {
      profile: ctx.profile,
    });
    const stop = () => receiptAi.abort(source.id);
    ctx.signal.addEventListener('abort', stop);
    try {
      ctx.consumeModel?.();
      const result: any =
        (source as any).result && !v.force
          ? source
          : await receiptAi.analyze(
              source.id,
              {
                consent: true,
                stream: false,
                force: v.force,
                policyVersion: 4,
                profile: {
                  id: profile.id,
                  endpoint: profile.endpoint,
                  model: profile.model,
                  apiStyle: profile.apiStyle || 'chat-completions',
                },
              },
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
  private addMark(raw: any, ctx: WorkflowContext) {
    const actor = ctx.check();
    if (!this.marks) throw new ImportError('唛头服务未配置。', 503);
    const v = z
      .object({
        productId: z.number().int().positive(),
        attachmentId: z.string().uuid().optional(),
        title: z.string().trim().max(200).optional(),
      })
      .parse(raw);
    const file = this.localFile(ctx, v.attachmentId);
    const mime = file.meta.mime || 'application/octet-stream';
    if (!/^(?:application\/pdf|image\/(?:png|jpeg|webp))$/.test(mime))
      throw new ImportError('唛头只支持 PDF 和 PNG、JPG、WEBP 图片。', 415);
    const mark = this.marks.service.add(
      {
        productId: v.productId,
        bytes: file.bytes,
        name: file.meta.name,
        mime,
        title: v.title || '',
        fields: {},
        sourceKind: 'assistant',
      },
      actor,
    );
    return { id: mark.id, productId: v.productId, fileName: file.meta.name, verified: true, message: '原文件已挂到产品下。' };
  }
  private removeMark(raw: any, ctx: WorkflowContext) {
    const actor = ctx.check();
    if (!this.marks) throw new ImportError('唛头服务未配置。', 503);
    if (!askedInChat(MARK_REMOVE, ctx.text, this.previousUserText(ctx.threadId)))
      throw new ImportError('要用户明确说移除唛头才能移除。请先问用户。', 403);
    const v = z.object({ id: z.number().int().positive(), expectedVersion: z.number().int().positive() }).parse(raw);
    const before = this.marks.service.get(v.id);
    this.marks.service.remove(v.id, { expectedVersion: v.expectedVersion }, actor);
    return {
      id: v.id,
      productId: before.productId,
      fileName: before.fileName,
      verified: true,
      message: '已从产品上移除这份唛头，产品和订单没有变化。',
    };
  }
  private async recognizeMark(raw: any, ctx: WorkflowContext) {
    const manager = this.importManager();
    if (!this.marks) throw new ImportError('唛头识别未启用。', 503);
    const marks = this.marks;
    const v = z
      .object({
        attachmentId: z.string().uuid().optional(),
        workspaceId: z.string().uuid().optional(),
        force: z.boolean().default(false),
      })
      .parse(raw);
    let workspaceId = v.workspaceId;
    if (!workspaceId) {
      const original = this.localFile(ctx, v.attachmentId);
      workspaceId = (await manager.upload(original.bytes, original.meta.name, true)).workspace.id;
    }
    const w = manager.get(workspaceId!);
    if (w.mode !== 'mark')
      manager.setMode(workspaceId!, { expectedRevision: w.revision, mode: 'mark' });
    if (!manager.markReview(workspaceId!)?.committed) {
      let sourceId = '';
      const stop = () => sourceId && marks.ai.abort(sourceId);
      ctx.signal.addEventListener('abort', stop);
      try {
        ctx.consumeModel?.();
        await marks.recognize(
          workspaceId!,
          { force: v.force, stream: false, policyVersion: 4, profile: ctx.profile },
          () => ctx.check(),
          { onSource: (id) => (sourceId = id) },
        );
      } finally {
        ctx.signal.removeEventListener('abort', stop);
      }
    }
    return marks.summary(workspaceId!);
  }
  private async attachMark(raw: any, ctx: WorkflowContext) {
    const manager = this.importManager();
    if (!this.marks) throw new ImportError('唛头识别未启用。', 503);
    const v = z
      .object({
        workspaceId: z.string().uuid(),
        choices: z
          .array(
            z.object({
              key: z.string(),
              productId: z.number().int().positive().optional(),
              newName: z.string().min(1).max(200).optional(),
              skip: z.boolean().optional(),
            }),
          )
          .min(1),
      })
      .parse(raw);
    const review = manager.markReview(v.workspaceId);
    if (!review) throw new ImportError('请先识别唛头。', 409);
    const items = review.items.map((item) => {
      const c = v.choices.find((x) => x.key === item.key);
      if (!c) return item;
      if (c.skip) return { ...item, skip: true };
      if (c.newName)
        return {
          ...item,
          choice: {
            mode: 'new' as const,
            name: c.newName,
            customerProductCode: item.fields.itemCode || null,
          },
        };
      if (c.productId) return { ...item, choice: { mode: 'existing' as const, id: c.productId } };
      return item;
    });
    if (!review.committed) {
      const saved: any = this.marks.saveItems(
        v.workspaceId,
        manager.get(v.workspaceId).revision,
        items as any,
      );
      await this.marks.commit(
        v.workspaceId,
        { expectedRevision: saved.revision, requestId: randomUUID() },
        () => ctx.check(),
      );
    }
    return this.marks.summary(v.workspaceId);
  }
}
