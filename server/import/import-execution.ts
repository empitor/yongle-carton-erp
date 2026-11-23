import { sales } from '../sales/index.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { one, parseStoredJson, rows, type Actor, type Store } from '../core/index.js';
import { AppError, assertPreviewCurrent, audit, previewDigest, requirePermission } from '../core/index.js';
import { customerSchema, productSchema, orderSchema } from '../../shared/core/index.js';
import { importExecuteSchema, workspaceRevisionSchema, type ImportPreview, type ImportReceipt, type Plan } from '../../shared/import/index.js';
import type { ImportManager } from './manager.js';
import { assertConfirmed, checkReferences, importPlan, purchaseOrderTaken } from './import-plan.js';
import { findFileImports, findOwnImport, fingerprintImported } from './import-records.js';
import { storedReceipt, type StoredReceipt } from './import-receipt.js';
import { checkedForWrite } from './workspace-document.js';

const receiptRow = rows.import_executions.pick({ document: true });
/** 写进库的导入回执文字：先按结构认一遍（对不上见 checkedForWrite） */
function receiptText(receipt: StoredReceipt) {
  checkedForWrite(storedReceipt, receipt, `import_executions.document（${receipt.executionId}）`);
  return JSON.stringify(receipt);
}
/** 读文件时文件不在（第一次归档这份原件） */
const missingFile = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** 原件存进导入归档目录（按文件哈希一份）；已有的核对哈希，坏了就停下。 */
async function archiveOriginal(root: string, fileHash: string, bytes: Buffer) {
  const directory = join(root, fileHash),
    sourcePath = join(directory, 'original');
  await mkdir(directory, { recursive: true });
  try {
    const saved = await readFile(sourcePath);
    if (createHash('sha256').update(saved).digest('hex') !== fileHash)
      throw new AppError('已归档原件损坏，请先恢复备份。', 409);
  } catch (error) {
    if (!missingFile(error)) throw error;
    const temp = join(directory, randomUUID() + '.tmp'),
      file = await open(temp, 'wx');
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, sourcePath);
  }
  return sourcePath;
}

/** 回给页面和助手的回执：只给 ImportReceipt 的几项；服务器上的原件路径、操作人只留在库里的导入记录 */
function pageReceipt(r: ImportReceipt): ImportReceipt {
  const { executionId, orderId, orderNumber, sourceId, fileHash, fileName, at, digest, created, orderVersion } = r;
  return { executionId, orderId, orderNumber, sourceId, fileHash, fileName, at, digest, created, orderVersion };
}

/**
 * 正式导入：先预览（导入计划和预览摘要，server/core/preview-digest.ts），确认时按当前数据重算计划、摘要对上了
 * 才在一个事务里建客户、产品和订单，写导入记录和审计。同一个人拿同一份预览摘要重复提交只返回第一次的结果。
 */
export class ImportExecutionService {
  constructor(
    private store: Store,
    private manager: ImportManager,
  ) {}
  private actor(who: Actor | null | undefined) {
    const a = requirePermission(who, 'import:execute');
    requirePermission(a, 'business:edit');
    return a;
  }
  /** 这份工作区导入时存下的回执（没导入过是 null） */
  private stored(sourceId: string): StoredReceipt | undefined {
    const row = one(this.store.db, receiptRow, 'SELECT document FROM import_executions WHERE source_id=?', sourceId);
    return row ? parseStoredJson(storedReceipt, row.document, `import_executions.document（工作区 ${sourceId}）`) : undefined;
  }
  receipt(id: string, who: Actor) {
    requirePermission(who, 'business:edit');
    const r = this.stored(z.uuid().parse(id));
    return r ? pageReceipt(r) : null;
  }
  /** 导入预览：导入计划（给人看）和预览摘要，正式导入时带回摘要和这一版识别结果的版本号 */
  async preview(id: string, raw: unknown, who: Actor | null | undefined): Promise<ImportPreview> {
    this.actor(who);
    const input = workspaceRevisionSchema.parse(raw);
    return this.manager.withImportSource(id, input.expectedRevision, async (w) => {
      const plan = importPlan(this.store, w);
      return { previewDigest: previewDigest(plan), plan };
    });
  }
  /** 同一个人拿同一份预览摘要再交（网络断了重试）：这个工作区导入过的回执原样返回；别的情况返回 undefined */
  private replay(id: string, actor: Actor, digest: string) {
    const receipt = this.stored(id);
    return receipt?.actor.id === actor.id && receipt.digest === digest ? pageReceipt(receipt) : undefined;
  }
  async execute(
    id: string,
    raw: unknown,
    who: Actor | null | undefined,
    recheck?: () => Actor | null,
  ): Promise<ImportReceipt> {
    const actor = this.actor(who),
      input = importExecuteSchema.parse(raw);
    const prior = this.replay(id, actor, input.previewDigest);
    if (prior) return prior;
    return this.manager.withImportSource(id, input.expectedRevision, async (w, bytes) => {
      // 按当前的识别结果、档案和规则重算导入计划，和预览时人看到的对不上就停下
      const plan = importPlan(this.store, w);
      assertPreviewCurrent(input.previewDigest, previewDigest(plan));
      assertConfirmed(plan, input.distinctProducts);
      const sourcePath = await archiveOriginal(this.manager.archiveDirectory, w.fileHash, bytes);
      const liveActor = this.actor(recheck ? recheck() : actor);
      if (liveActor.id !== actor.id) throw new AppError('登录身份已变化，请重新确认。', 403);
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        const replay = this.replay(id, actor, input.previewDigest);
        if (replay) {
          this.store.db.exec('COMMIT');
          return replay;
        }
        // 归档原件要等待，等待之间别的写入可能插进来：进了事务再按当前数据核对一遍
        assertPreviewCurrent(input.previewDigest, previewDigest(importPlan(this.store, w)));
        const receipt = this.write({ id, fileHash: w.fileHash, fileName: w.fileName, sourcePath }, plan, actor, input.previewDigest);
        this.store.db.exec('COMMIT');
        return receipt;
      } catch (error) {
        this.store.db.exec('ROLLBACK');
        throw error;
      }
    });
  }
  /** 事务里：再核一遍档案和重复，建客户、产品、订单，写导入记录和审计 */
  private write(
    source: { id: string; fileHash: string; fileName: string; sourcePath: string },
    plan: Plan,
    actor: Actor,
    digest: string,
  ) {
    const { id, sourcePath } = source,
      w = source;
    checkReferences(this.store, plan.customer, plan.products);
    if (findOwnImport(this.store, id)) throw new AppError('本工作区已导入，未重复写入。', 409, 'duplicate');
    if (findFileImports(this.store, w.fileHash).some((r) => !r.permanentlyDeleted))
      throw new AppError('同一原件已有有效或已归档的订单，请先核对或恢复原订单；事务未重复写入。', 409, 'duplicate');
    if (fingerprintImported(this.store, plan.fingerprint) || purchaseOrderTaken(this.store, plan.customer, plan.order))
      throw new AppError('检测到重复订单或采购单号，事务未写入。', 409, 'duplicate');
    const created: { entity: string; id: number }[] = [],
      customerId =
        plan.customer.mode === 'existing'
          ? plan.customer.id
          : sales(this.store).createCustomer(customerSchema.parse(plan.customer.input)).id;
    if (plan.customer.mode === 'new') created.push({ entity: 'customers', id: customerId });
    const cache = new Map<string, number>(),
      productIds = plan.products.map((p) => {
        if (p.mode === 'existing') return p.id;
        const cached = cache.get(p.key);
        if (cached !== undefined) return cached;
        const product = sales(this.store).createProduct(productSchema.parse(p.input));
        cache.set(p.key, product.id);
        created.push({ entity: 'products', id: product.id });
        return product.id;
      });
    const order = sales(this.store).saveOrder(
      orderSchema.parse({ ...plan.order, customerId, lines: plan.order.lines.map((l, i) => ({ ...l, productId: productIds[i] })) }),
    );
    const receipt = {
      executionId: randomUUID(),
      orderId: order.id,
      orderNumber: order.number,
      sourceId: id,
      fileHash: w.fileHash,
      fileName: w.fileName,
      sourcePath,
      at: new Date().toISOString(),
      actor: { id: actor.id, name: actor.name },
      digest,
      created,
      orderVersion: order.version,
    };
    this.store.db
      .prepare('INSERT INTO import_executions(id,source_id,file_hash,fingerprint,order_id,actor_id,created_at,document) VALUES(?,?,?,?,?,?,?,?)')
      .run(receipt.executionId, id, w.fileHash, plan.fingerprint, order.id, actor.id, receipt.at, receiptText({ ...receipt, plan }));
    audit(this.store, actor, {
      action: 'create',
      entity: 'orders',
      id: order.id,
      document: { receipt, before: null, after: order, plan },
    });
    for (const c of created)
      audit(this.store, actor, {
        action: 'create',
        entity: c.entity,
        id: c.id,
        document: {
          before: null,
          after: c.entity === 'customers' ? sales(this.store).customer(c.id) : sales(this.store).product(c.id),
          executionId: receipt.executionId,
        },
      });
    return pageReceipt(receipt);
  }
}
