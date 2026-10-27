import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import type { ImportManager } from '../import/manager.js';
import type { ImportWorkspaceView } from '../../shared/order-draft.js';
import {
  customerSchema,
  productSchema,
  orderSchema,
  type OrderInput,
} from '../../shared/domain.js';
import { standardOrderDraft } from '../import/standard-order.js';
import { ImportError } from '../import/errors.js';
import { audit, requirePermission, changeLifecycle } from './management.js';
import { CATALOG_VERSION } from './metadata.js';
import {
  normalizedDimensions,
  normalizeDimensionUnit,
  hasCompleteProductIdentity,
  uniqueMessages,
} from '../../shared/product-details.js';
import { productFieldsFromDraft } from '../import/product-input.js';
type Ref =
  | { mode: 'existing'; id: number; version: number; name: string }
  | { mode: 'new'; key: string; input: any; name: string };
type Plan = {
  catalogVersion: string;
  policyVersion: string;
  source: { id: string; hash: string; fileName: string; revision: number };
  customer: Ref;
  products: Ref[];
  order: any;
  fingerprint: string;
  total: string;
  warnings: string[];
};
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const key = (s: string) => s.trim().replace(/\s+/g, '').toLowerCase();
const productKey = (p: any) =>
  hash([
    key(p.name || ''),
    ...normalizedDimensions(p),
    normalizeDimensionUnit(p.dimensionUnit) ? 'known' : p.dimensionUnitRaw || 'unknown',
    key(p.material || ''),
    key(p.flute || ''),
    key(p.requirements || ''),
    key(p.customerProductCode || ''),
  ]);
const price = (v: string) => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);
function fingerprint(customer: string, order: any) {
  return hash([
    key(customer),
    order.externalPurchaseOrder ? key(order.externalPurchaseOrder) : '',
    order.orderDate,
    order.deliveryDate,
    order.lines
      .map((l: any) => [
        key(l.productName || ''),
        key(l.specification),
        l.quantity,
        l.unit,
        price(l.unitPriceExact ?? String(l.unitPriceCents / 100)),
      ])
      .sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ]);
}
function refFromRow(store: Store, row: any): NonNullable<ImportWorkspaceView['imported']> {
  let receipt: any = {};
  try {
    receipt = JSON.parse(String(row.document));
  } catch {
    /* 旧记录损坏时仅保留台账标识，不伪造订单信息 */
  }
  const base = {
    executionId: String(row.id),
    orderId: Number(receipt.orderId ?? 0),
    orderNumber: String(receipt.orderNumber ?? ''),
    sourceId: String(row.source_id),
  };
  if (row.order_id === null) return { ...base, archived: true, permanentlyDeleted: true };
  const order = store.orders(true).find((o) => o.id === Number(row.order_id));
  return order
    ? {
        ...base,
        orderId: order.id,
        orderNumber: order.number,
        archived: store.archived('orders', order.id),
      }
    : { ...base, archived: true, permanentlyDeleted: true };
}
/** 该导入工作区自己的执行记录（source_id 唯一）。只用于本任务幂等和旧工作区只读判断。 */
export function findOwnImport(store: Store, sourceId: string) {
  const row = store.db.prepare('SELECT * FROM import_executions WHERE source_id=?').get(sourceId);
  return row ? refFromRow(store, row) : undefined;
}
/** 同一原件的全部历史执行记录，按时间倒序。用于区分有效订单、回收站和已永久删除。 */
export function findFileImports(store: Store, fileHash: string) {
  return store.db
    .prepare('SELECT * FROM import_executions WHERE file_hash=? ORDER BY rowid DESC')
    .all(fileHash)
    .map((row: any) => refFromRow(store, row));
}
/**
 * 兼容查询：本工作区已导入时返回 own（historical=false）；
 * 否则返回同一原件的最近历史（historical=true），仅用于提示“此前处理过”，不阻断识别。
 */
export function findImport(
  store: Store,
  id: string,
  fileHash?: string,
): ImportWorkspaceView['imported'] {
  const own = findOwnImport(store, id);
  if (own) return own;
  if (!fileHash) return undefined;
  const row = store.db
    .prepare('SELECT * FROM import_executions WHERE file_hash=? ORDER BY rowid DESC LIMIT 1')
    .get(fileHash);
  return row ? { ...refFromRow(store, row), historical: true } : undefined;
}
export class ImportExecutionService {
  constructor(
    private store: Store,
    private manager: ImportManager,
    private archiveRoot: string,
  ) {}
  private actor(who: Actor | null | undefined) {
    const a = requirePermission(who, 'import:execute');
    requirePermission(a, 'business:edit');
    return a;
  }
  private plan(w: ImportWorkspaceView): Plan {
    if (w.mode === 'arrival')
      throw new ImportError('到货单只能通过收货确认进入原材料库存，不能导入为客户订单。', 409);
    if (findOwnImport(this.store, w.id))
      throw new ImportError(
        '本工作区已导入正式订单，不能重复创建；如需再次导入同一原件，请重新上传建立新的导入任务。',
        409,
        'duplicate',
      );
    const history = findFileImports(this.store, w.fileHash).filter((r) => r.sourceId !== w.id);
    const active = history.find((r) => !r.permanentlyDeleted && !r.archived);
    if (active)
      throw new ImportError(
        '同一文件此前已导入有效订单 ' +
          active.orderNumber +
          '，请到订单管理核对；如确需重新创建，请先归档或永久删除原订单，再重新导入。',
        409,
        'duplicate',
      );
    const trashed = history.find((r) => !r.permanentlyDeleted && r.archived);
    if (trashed)
      throw new ImportError(
        '同一文件此前的订单 ' +
          trashed.orderNumber +
          ' 在业务回收站，请先在订单管理恢复原订单；如确认不需要该订单，可永久删除后再导入同一原件。',
        409,
        'duplicate',
      );
    if (!w.draft) throw new ImportError('请先识别订单。');
    const mapping = structuredClone(
      w.mapping || { customer: { mode: 'pending' }, products: {}, roundingPolicy: 'exact-cents' },
    ) as any;
    const customers = this.store.customers(),
      products = this.store.products(),
      name = w.draft.header.buyerName.value || '';
    if (mapping.customer.mode === 'pending') {
      const exact = customers.filter((c) => key(c.name) === key(name));
      if (exact.length === 1)
        mapping.customer = { mode: 'existing', id: exact[0].id, version: exact[0].version };
      else if (
        exact.length ||
        customers.some((c) => key(c.name).includes(key(name)) || key(name).includes(key(c.name)))
      )
        throw new ImportError(
          '客户匹配存在歧义，请在客户档案下拉框中明确选择或选择计划新建，再保存选择。',
        );
      else mapping.customer = { mode: 'new' };
    }
    for (const l of w.draft.lines) {
      const f = l.fields,
        definition = (() => {
          try {
            return productFieldsFromDraft(f);
          } catch {
            throw new ImportError(
              '产品“' + (f.productName.value || '未命名') + '”尺寸必须为有效正数，缺失时请留空。',
            );
          }
        })();
      if (
        definition.dimensionUnit === 'cm' &&
        [definition.length, definition.width, definition.height].some((n) => n !== null && n > 1000)
      )
        throw new ImportError(
          '产品“' + definition.name + '”厘米尺寸超过1000cm，请修正数值或单位。',
        );
      const choice = mapping.products[l.id] || { mode: 'pending' };
      if (choice.mode === 'pending') {
        const exact = hasCompleteProductIdentity(definition)
          ? products.filter(
              (p) => hasCompleteProductIdentity(p) && productKey(p) === productKey(definition),
            )
          : [];
        if (exact.length === 1)
          mapping.products[l.id] = { mode: 'existing', id: exact[0].id, version: exact[0].version };
        else if (
          exact.length ||
          products.some(
            (p) =>
              key(p.name) === key(definition.name || '') ||
              (definition.customerProductCode &&
                p.customerProductCode === definition.customerProductCode),
          )
        )
          throw new ImportError(
            '第' +
              (w.draft.lines.indexOf(l) + 1) +
              '项产品有相似或不完整匹配，请明确选择产品或计划新建并保存选择。',
          );
        else mapping.products[l.id] = { mode: 'new' };
      }
    }
    const projection = standardOrderDraft(this.store, { ...w, mapping })!;
    if (projection.issues.length) throw new ImportError(projection.issues.join('；'));
    const customer: Ref =
      mapping.customer.mode === 'existing'
        ? { ...mapping.customer, name: this.store.customer(mapping.customer.id)!.name }
        : {
            mode: 'new',
            key: key(name),
            input: customerSchema.parse(projection.newCustomerPlan),
            name,
          };
    const refs: Ref[] = w.draft.lines.map((l) => {
      const choice = mapping.products[l.id];
      return choice.mode === 'existing'
        ? { ...choice, name: this.store.product(choice.id)!.name }
        : {
            mode: 'new',
            key:
              productKey(projection.newProductPlans.find((p) => p.lineId === l.id)!.input) +
              (hasCompleteProductIdentity(
                projection.newProductPlans.find((p) => p.lineId === l.id)!.input,
              )
                ? ''
                : ':' + l.id),
            input: productSchema.parse(
              projection.newProductPlans.find((p) => p.lineId === l.id)!.input,
            ),
            name: l.fields.productName.value!,
          };
    });
    this.checkReferences(customer, refs);
    // 使用临时正ID只验证结构，正式ID将在同一个数据库事务中建立。
    const order = orderSchema.parse({
      ...projection.fields,
      customerId: customer.mode === 'existing' ? customer.id : 1,
      lines: projection.fields.lines.map((l: any, i) => ({
        ...l,
        productId: refs[i].mode === 'existing' ? (refs[i] as any).id : 1,
      })),
    });
    const signature = fingerprint(
      customer.mode === 'existing' ? 'customer:' + customer.id : customer.name,
      order,
    );
    const duplicate = this.store
      .orders(true)
      .find(
        (o) =>
          (order.externalPurchaseOrder &&
            (customer.mode === 'existing'
              ? o.customerId === customer.id
              : key(o.customerName) === key(customer.name)) &&
            key(o.externalPurchaseOrder || '') === key(order.externalPurchaseOrder)) ||
          fingerprint(
            customer.mode === 'existing' ? 'customer:' + o.customerId : o.customerName,
            o,
          ) === signature,
      );
    if (duplicate)
      throw new ImportError(
        '检测到相同采购单号或相同订单内容：' +
          duplicate.number +
          '。请核对历史订单，本版不会自动覆盖或重复新增。',
        409,
        'duplicate',
      );
    return {
      catalogVersion: CATALOG_VERSION,
      policyVersion: 'reviewed-import-v3',
      source: { id: w.id, hash: w.fileHash, fileName: w.fileName, revision: w.revision },
      customer,
      products: refs,
      order,
      fingerprint: signature,
      total: w.evaluation!.totalAmount!,
      warnings: uniqueMessages([
        ...projection.notices,
        ...w.evaluation!.issues.map((i) => i.message),
      ]),
    };
  }
  private checkReferences(customer: Ref, products: Ref[]) {
    if (customer.mode === 'existing') {
      const c = this.store.customer(customer.id);
      if (!c || c.version !== customer.version)
        throw new ImportError('客户已变化或已停用，请重新预览。', 409);
    } else if (this.store.customers(true).some((c) => key(c.name) === key(customer.name)))
      throw new ImportError('同名客户已存在（可能已停用），请选择已有档案或先恢复。', 409);
    for (const p of products)
      if (p.mode === 'existing') {
        const found = this.store.product(p.id);
        if (!found || found.version !== p.version)
          throw new ImportError('产品已变化或已停用，请重新预览。', 409);
      } else if (
        hasCompleteProductIdentity(p.input) &&
        this.store
          .products(true)
          .some(
            (existing) => hasCompleteProductIdentity(existing) && productKey(existing) === p.key,
          )
      )
        throw new ImportError('相同产品已经存在（可能已停用），请选择已有档案或先恢复。', 409);
  }
  async preview(id: string, raw: unknown, who: Actor | null | undefined) {
    const actor = this.actor(who),
      input = z.strictObject({ expectedRevision: z.number().int().nonnegative() }).parse(raw);
    return this.manager.withImportSource(id, input.expectedRevision, async (w) => {
      const plan = this.plan(w),
        preview = {
          id: randomUUID(),
          digest: hash(plan),
          expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
          plan,
        };
      this.store.db
        .prepare('INSERT INTO import_previews VALUES(?,?,?,?,?,?,?)')
        .run(
          preview.id,
          id,
          w.revision,
          actor.id,
          preview.expiresAt,
          preview.digest,
          JSON.stringify(plan),
        );
      return preview;
    });
  }
  async execute(
    id: string,
    raw: unknown,
    who: Actor | null | undefined,
    recheck?: () => Actor | null,
  ) {
    const actor = this.actor(who),
      input = z
        .strictObject({ previewId: z.string().uuid(), acknowledged: z.literal(true) })
        .parse(raw),
      preview = this.store.db
        .prepare('SELECT * FROM import_previews WHERE id=?')
        .get(input.previewId);
    if (!preview || preview.actor_id !== actor.id || preview.source_id !== id)
      throw new ImportError('导入预览不存在或不属于当前登录用户。', 403);
    const prior = this.store.db
      .prepare('SELECT document FROM import_executions WHERE preview_id=?')
      .get(input.previewId);
    if (prior) return JSON.parse(String(prior.document));
    if (String(preview.expires_at) < new Date().toISOString())
      throw new ImportError('导入预览已过期，请重新生成。', 409);
    const plan = JSON.parse(String(preview.document)) as Plan;
    if (hash(plan) !== preview.digest) throw new ImportError('预览摘要不一致，已停止导入。', 409);
    return this.manager.withImportSource(id, Number(preview.revision), async (w, bytes) => {
      if (hash(this.plan(w)) !== preview.digest)
        throw new ImportError('草稿、关联或业务规则已变化，请重新预览。', 409);
      const directory = join(this.archiveRoot, w.fileHash),
        sourcePath = join(directory, 'original');
      await mkdir(directory, { recursive: true });
      try {
        const saved = await readFile(sourcePath);
        if (createHash('sha256').update(saved).digest('hex') !== w.fileHash)
          throw new ImportError('已归档原件损坏，请先恢复备份。', 409);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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
      const liveActor = this.actor(recheck ? recheck() : actor);
      if (liveActor.id !== actor.id) throw new ImportError('登录身份已变化，请重新确认。', 403);
      if (String(preview.expires_at) < new Date().toISOString())
        throw new ImportError('预览已过期，请重新生成。', 409);
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        const replay = this.store.db
          .prepare('SELECT document FROM import_executions WHERE preview_id=?')
          .get(input.previewId);
        if (replay) {
          this.store.db.exec('COMMIT');
          return JSON.parse(String(replay.document));
        }
        this.checkReferences(plan.customer, plan.products);
        if (findOwnImport(this.store, id))
          throw new ImportError('本工作区已导入，未重复写入。', 409, 'duplicate');
        if (findFileImports(this.store, w.fileHash).some((r) => !r.permanentlyDeleted))
          throw new ImportError(
            '同一原件已有有效或回收站订单，请先核对或恢复原订单；事务未重复写入。',
            409,
            'duplicate',
          );
        const liveFingerprint = this.store.db
          .prepare('SELECT order_id FROM import_executions WHERE fingerprint=?')
          .all(plan.fingerprint)
          .some(
            (row: any) =>
              row.order_id !== null &&
              this.store.orders(true).some((o) => o.id === Number(row.order_id)),
          );
        if (
          liveFingerprint ||
          this.store
            .orders(true)
            .some(
              (o) =>
                plan.order.externalPurchaseOrder &&
                (plan.customer.mode === 'existing'
                  ? o.customerId === plan.customer.id
                  : key(o.customerName) === key(plan.customer.name)) &&
                key(o.externalPurchaseOrder || '') === key(plan.order.externalPurchaseOrder),
            )
        )
          throw new ImportError('检测到重复订单或采购单号，事务未写入。', 409, 'duplicate');
        const created: { entity: string; id: number }[] = [],
          customerId =
            plan.customer.mode === 'existing'
              ? plan.customer.id
              : this.store.saveCustomer(customerSchema.parse(plan.customer.input)).id;
        if (plan.customer.mode === 'new') created.push({ entity: 'customers', id: customerId });
        const cache = new Map<string, number>(),
          productIds = plan.products.map((p) => {
            if (p.mode === 'existing') return p.id;
            if (cache.has(p.key)) return cache.get(p.key)!;
            const product = this.store.saveProduct(productSchema.parse(p.input));
            cache.set(p.key, product.id);
            created.push({ entity: 'products', id: product.id });
            return product.id;
          });
        const order = this.store.saveOrder(
          orderSchema.parse({
            ...plan.order,
            customerId,
            lines: plan.order.lines.map((l: any, i: number) => ({
              ...l,
              productId: productIds[i],
            })),
          }),
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
          previewId: input.previewId,
          digest: String(preview.digest),
          created,
          orderVersion: order.version,
        };
        this.store.db
          .prepare('INSERT INTO import_executions VALUES(?,?,?,?,?,?,?,?,?)')
          .run(
            receipt.executionId,
            input.previewId,
            id,
            w.fileHash,
            plan.fingerprint,
            order.id,
            actor.id,
            receipt.at,
            JSON.stringify({ ...receipt, plan }),
          );
        audit(this.store, actor, 'reviewed-import', 'create', 'orders', order.id, {
          receipt,
          before: null,
          after: order,
          plan,
        });
        for (const c of created)
          audit(this.store, actor, 'reviewed-import', 'create', c.entity, c.id, {
            before: null,
            after: c.entity === 'customers' ? this.store.customer(c.id) : this.store.product(c.id),
            executionId: receipt.executionId,
          });
        this.store.db.exec('COMMIT');
        return receipt;
      } catch (error) {
        this.store.db.exec('ROLLBACK');
        throw error;
      }
    });
  }
  undo(id: string, who: Actor | null | undefined) {
    const actor = requirePermission(who, 'import:restore'),
      row = this.store.db.prepare('SELECT * FROM import_executions WHERE source_id=?').get(id);
    if (!row) throw new ImportError('没有正式导入记录。', 404);
    if (row.order_id === null)
      throw new ImportError('正式订单已被超级管理员永久删除，不能撤回或恢复。', 409);
    const record = JSON.parse(String(row.document)),
      order = this.store.orders(true).find((o) => o.id === Number(row.order_id));
    if (!order || order.version !== record.orderVersion)
      throw new ImportError('正式订单已被后续修改，不能直接撤回，请在订单管理中核对处理。', 409);
    // 仅保留旧“撤回导入”协议的兼容状态；正常页面已移除此入口，delete走物理删除服务。
    this.store.db.prepare('INSERT OR IGNORE INTO record_lifecycle VALUES(?,?,?,?)').run('orders',order.id,new Date().toISOString(),actor.id);
    audit(this.store,actor,'legacy-import-undo','undo-import','orders',order.id,{before:order,sourceId:id});
    return {results:[{id:order.id,success:true,message:'旧版导入撤回状态已保留'}]};
  }
}
