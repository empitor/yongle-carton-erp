import { z } from 'zod';
import { FINISHED_UNIT, RAW_UNIT, finishedUnitMessage, rawUnitMessage, stockUnit } from '../../../shared/core/index.js';
import type { Store } from '../../core/index.js';
import type { Actor } from '../../core/index.js';
import { AppError, audit, exists, inSavepoint, isLocalAdministrator, isSuperMode, many, one, rows } from '../../core/index.js';
import { stockItemSchema, rawStockKey, type ArrivalItem, type StockItemBaseView } from '../../../shared/business/index.js';
import { normalizedDimensions, normalizeDimensionUnit, specification, type Product } from '../../../shared/core/index.js';
import type { OperationsRepository } from '../ledger/repository.js';
import { stockDocumentText } from '../ledger/stock-document.js';
import { businessActor, priorRecord } from '../ledger/write-base.js';

/** 库存品用过没有：有出入库记录是 moved，没有流水但被单据或采购明细引用是 referenced */
const stockUsages = ['moved', 'referenced'] as const;
type StockUsage = (typeof stockUsages)[number];
/**
 * 改已有库存品时调用方（单据流转的保存入口 server/flow/stock-entries.ts）给的单据事实和连带：
 * referenced 这个库存品被单据引用过（有流水、被采购明细引用的采购库存自己查）；
 * alignStock 本机管理员改了以后，在同一保存点里让已有单据跟着对齐（采购库存在写完、记审计前调）。
 */
export type ItemEdit = {
  id: number;
  referenced: boolean;
  alignStock(before: StockItemBaseView, after: StockItemBaseView, actor: Actor): void;
};
/** 要保存的库存品：录入规则核对过、单位按种类定好的 */
type ItemValues = z.output<typeof stockItemSchema>;
/** 原材料的内容（到货明细的 item）：到货没选库存品时按它对上已有的原材料，没有就按它新建 */
export type RawItem = ArrivalItem;
/** 认原材料只看名称、规格、尺寸、材质、楞型（查重键 rawStockKey） */
type RawIdentity = Parameters<typeof rawStockKey>[0];

const idName = rows.stock_items.pick({ id: true, name: true });
const usageRow = z.object({ id: z.number(), usage: z.enum(stockUsages).nullable() });

/**
 * 撞上已有的库存品（这个产品已经有成品库存、已经有一样的原材料）：details 带着已有那个的编号、名称、种类、是否归档，
 * 页面据此给“打开它”的入口（server/app.ts 把 details 放进返回的 JSON）。
 */
export class StockConflictError extends AppError {
  constructor(
    message: string,
    readonly details: { stockId: number; name: string; kind: 'raw' | 'finished'; archived: boolean },
  ) {
    super(message, 409, 'stock-exists');
  }
}
/**
 * 成品库存的名称、尺寸、材质、楞型、规格说明一律取产品的（规格说明是产品的尺寸、材质、楞型、加工要求拼成的
 * shared/core/domain.ts 的 specification），成品库存自己能改的只有备注
 */
export const finishedFromProduct = (product: Product) => ({
  name: product.name,
  length: product.length ?? null,
  width: product.width ?? null,
  height: product.height ?? null,
  dimensionUnit: product.dimensionUnit ?? null,
  material: product.material ?? '',
  flute: product.flute ?? '',
  specification: specification(product),
});
const dimensionsKey = (v: Parameters<typeof normalizedDimensions>[0]) =>
  JSON.stringify([
    normalizedDimensions(v),
    normalizeDimensionUnit(v.dimensionUnit) ? 'known' : 'unknown',
  ]);
/** 用过的库存品不能改的几项（尺寸另按换算后的值比） */
const fixedOnceUsed = ['kind', 'unit', 'material', 'flute', 'productId', 'specification'] as const;

/**
 * 库存品的档案规则：保存库存品（成品按产品、原材料按查重键，同一种货只有一个）、用没用过、
 * 登记完工和到货时自动对应（没有就建、归档了就恢复）。
 */
export class StockItems {
  constructor(
    readonly store: Store,
    private readonly repo: OperationsRepository,
  ) {}
  /**
   * 保存库存品档案。同一种货只有一个库存品（归档的也算）：
   * - 成品一定关联产品，一个产品只有一个成品库存；名称、尺寸、材质、楞型、规格说明一律按产品填（不信传进来的值），
   *   只有备注是库存品自己的；
   * - 原材料不关联产品；名称、规格说明、尺寸、材质、楞型规范化后（rawStockKey）一样的只能有一个。
   * 撞上已有的抛 StockConflictError，带着已有那个的编号，页面给“打开它”的入口。数据库上另有约束和唯一索引兜底。
   * 改已有的（edit）要调用方给单据事实和连带（ItemEdit）；新建不用。
   */
  saveItem(
    raw: unknown,
    who: Actor | null | undefined,
    edit?: ItemEdit,
    /** 不是人在库存页保存，而是登记完工、到货时自动建的：审计里写明原因和单据，和人手动新建分得开 */
    origin?: { reason: string; document?: string },
  ) {
    const actor = businessActor(who),
      parsed = stockItemSchema.parse(raw),
      // 成品存“只”（“个”、没写都算），原材料存“张”
      input = { ...parsed, unit: stockUnit(parsed.kind, parsed.unit) };
    return inSavepoint(this.store.db, () => {
      const before = edit ? priorRecord((all) => this.repo.items(all, edit.id)[0], raw, actor) : null;
      if (before && edit) this.assertKindAndProductKept(before, input, edit.referenced);
      const v = this.checkedValues(input, before, actor);
      this.assertNoTwin(v, edit?.id);
      if (before) this.assertSpecKept(before, v, actor);
      const savedId = this.writeItem(v, edit?.id);
      const after = this.repo.items(true, savedId)[0];
      if (before && edit && isLocalAdministrator(actor)) edit.alignStock(before, after, actor);
      audit(this.store, actor, {
        action: before ? 'update' : 'create',
        entity: 'stock_items',
        id: savedId,
        document: { before, after, ...(origin ? { reason: origin.reason, document: origin.document ?? null } : {}) },
      });
      return after;
    });
  }
  /**
   * 已经用过的库存品（有出入库记录，或者被单据、采购明细引用）有两样谁都不能改，本机管理员也不行；
   * 放在单位规则前面，不用连单位一起改才看得到真正的原因。从没用过的库存品照旧能改（改成别的产品时，
   * 那个产品还不能有成品库存，assertNoTwin 查）。
   * - 种类：种类定了数量单位（原材料“张”、成品“只”，数据库约束），改种类等于把历史的“张”直接当成“只”。
   * - 成品关联的产品：以前的完工、出库都记在原来的产品上，换了产品，完工单、送货单明细和订单行就对不上，
   *   成本也会算到别的产品名下。
   */
  private assertKindAndProductKept(before: StockItemBaseView, v: ItemValues, referenced: boolean) {
    if (before.kind === v.kind && (before.productId == null || before.productId === v.productId)) return;
    const usage = this.localUsages([before.id]).get(before.id) ?? (referenced ? 'referenced' : null);
    if (!usage) return;
    const used = usage === 'moved' ? '已有出入库记录' : '已被单据或采购明细引用';
    throw new AppError(
      before.kind !== v.kind
        ? '这个库存品' + used + '，不能改种类（原材料按“张”、成品按“只”，数量不能互相换算）；请新建一个库存品。'
        : '这个成品' + used + '，不能改关联的产品（以前的完工和出库都记在原来的产品上）；另一种产品的成品请新建一个库存品。',
    );
  }
  /** 单位、种类和产品关联的规则；成品的名称、尺寸、材质、楞型、规格说明换成产品的 */
  private checkedValues(v: ItemValues, before: StockItemBaseView | null, actor: Actor): ItemValues {
    // 成品只有“只”、原材料只有“张”，别的单位拒收
    if (v.unit !== (v.kind === 'raw' ? RAW_UNIT : FINISHED_UNIT))
      throw new AppError(v.kind === 'raw' ? rawUnitMessage : finishedUnitMessage);
    if (v.kind === 'raw' && v.productId)
      throw new AppError('原材料不关联产品，只有成品库存关联产品；改成原材料时请同时清掉关联的产品。');
    if (v.kind === 'raw') return v;
    if (!v.productId)
      throw new AppError('成品库存要先选产品：一个产品对应一个成品库存，名称、尺寸、材质、楞型都按产品来。');
    // 已归档的产品不能新关联；原来就关联着它的成品照样能改备注
    const product = this.store.product(v.productId, isSuperMode(actor) || before?.productId === v.productId);
    if (!product) throw new AppError('关联产品不存在或已归档。');
    return { ...v, ...finishedFromProduct(product) };
  }
  /** 有流水或采购引用的库存品：除了本机管理员，数量单位、实际规格、类别和产品关联都不能改（等值的 mm/cm 换算不算改） */
  private assertSpecKept(before: StockItemBaseView, v: ItemValues, actor: Actor) {
    if (isLocalAdministrator(actor)) return;
    const changed =
      dimensionsKey(before) !== dimensionsKey(v) || fixedOnceUsed.some((k) => JSON.stringify(before[k]) !== JSON.stringify(v[k]));
    if (!changed) return;
    const used = exists(
      this.store.db,
      'SELECT 1 FROM stock_movements WHERE item_id=? UNION ALL SELECT 1 FROM purchase_lines WHERE stock_item_id=? LIMIT 1',
      before.id,
      before.id,
    );
    if (used)
      throw new AppError(
        '已有流水或采购引用，不能改动数量单位、实际规格、类别和产品关联；请新建库存品。等值mm/cm换算、名称和备注仍可编辑。',
      );
  }
  /** 写库存品那一行（内容按 document 列的结构核对），返回编号 */
  private writeItem(v: ItemValues, id: number | undefined) {
    const { name, kind, unit, productId, ...content } = v;
    const key = kind === 'raw' ? rawStockKey(v) : null,
      now = new Date().toISOString(),
      document = stockDocumentText(content, id ? '库存品 ' + id : '新库存品 ' + name);
    if (id) {
      this.store.db
        .prepare('UPDATE stock_items SET name=?,kind=?,unit=?,product_id=?,raw_key=?,document=?,updated_at=?,version=version+1 WHERE id=?')
        .run(name, kind, unit, productId, key, document, now, id);
      return id;
    }
    // 编号由数据库分配（AUTOINCREMENT，删掉的也不复用）
    return Number(
      this.store.db
        .prepare('INSERT INTO stock_items(name,kind,unit,product_id,raw_key,version,created_at,updated_at,document) VALUES(?,?,?,?,?,1,?,?,?)')
        .run(name, kind, unit, productId, key, now, now, document).lastInsertRowid,
    );
  }
  /**
   * 采购库存自己看得到的“用过”：有出入库记录是 moved，没有流水但被采购明细引用是 referenced；一次查齐，只返回用过的。
   * 被单据引用的由单据流转补（server/flow/stock-views.ts 的 usages：编辑窗的只读判断、数据管理的列表都用它），
   * saveItem 的拦截用这里的加上调用方给的 referenced，两边是同一个判断。
   */
  localUsages(ids: readonly number[]): Map<number, StockUsage> {
    if (!ids.length) return new Map();
    return new Map(
      many(
        this.store.db,
        usageRow,
        `SELECT j.value AS id,
           CASE WHEN EXISTS(SELECT 1 FROM stock_movements m WHERE m.item_id=j.value) THEN 'moved'
                WHEN EXISTS(SELECT 1 FROM purchase_lines l WHERE l.stock_item_id=j.value) THEN 'referenced' END AS usage
         FROM json_each(?) j`,
        JSON.stringify([...new Set(ids)]),
      ).flatMap((r) => (r.usage === null ? [] : [[r.id, r.usage] as const])),
    );
  }
  /**
   * 同一种货只有一个库存品，归档的也算：这个产品已经有成品库存、或者已经有一样的原材料，就拒绝新建或改成它
   * （改的是它自己不算）。提示里写出已有那个的名称，已归档的提示去恢复。
   */
  private assertNoTwin(v: ItemValues, id?: number) {
    const twin =
      v.kind === 'finished'
        ? one(this.store.db, idName, 'SELECT id,name FROM stock_items WHERE product_id=? AND id<>?', v.productId, id ?? 0)
        : one(this.store.db, idName, 'SELECT id,name FROM stock_items WHERE raw_key=? AND id<>?', rawStockKey(v), id ?? 0);
    if (!twin) return;
    const archived = this.store.archived('stock_items', twin.id);
    throw new StockConflictError(
      v.kind === 'finished'
        ? '产品“' + v.name + '”已经有成品库存“' + twin.name + '”' + (archived ? '（已归档）' : '') +
            '，一个产品只有一个成品库存，' + (archived ? '请到已归档里恢复它，不用再建。' : '不用再建。')
        : '已经有一样的原材料“' + twin.name + '”' + (archived ? '（已归档）' : '') +
            '：名称、规格、尺寸、材质、楞型都相同就是同一种货，' +
            (archived ? '请到已归档里恢复它，不用再建。' : '不用再建；质量不同的纸板请用名称或规格区分。'),
      { stockId: twin.id, name: twin.name, kind: v.kind, archived },
    );
  }
  /**
   * 完工入库用的成品库存：就是这个产品的那一个（一个产品只有一个，归档的也算）。
   * 没有就按产品新建一个（名称、尺寸、材质、楞型、规格说明都按产品）；已归档的自动恢复（写审计），
   * 不让人先去手动恢复。expected 是调用方指定的成品库存，不是这个产品的那一个就拒绝。
   * document 是因为哪张单据（比如“生产任务 SC-…”），新建、恢复的审计里都写上。调用方负责外层事务。
   */
  finishedStockFor(productId: number, who: Actor | null | undefined, expected?: number | null, document?: string) {
    const actor = businessActor(who),
      product = this.store.product(productId, true);
    if (!product) throw new AppError('产品不存在。', 404);
    const row = one(this.store.db, rows.stock_items.pick({ id: true }), 'SELECT id FROM stock_items WHERE product_id=?', productId);
    if (expected != null && (!row || row.id !== expected))
      throw new AppError(
        '入库的成品库存不是产品“' + product.name + '”的成品库存。一个产品只有一个成品库存，完工时按产品自动对应，不用另选。',
        409,
      );
    if (!row) {
      const item = this.saveItem({ name: product.name, kind: 'finished', productId, notes: '' }, actor, undefined, {
        reason: '登记完工时按产品自动新建',
        document,
      });
      return { item, created: true, restored: false };
    }
    return { ...this.restoredForUse(row.id, actor, '完工入库', document), created: false };
  }
  /**
   * 到货要入库、还没选库存品的原材料：已经有一样的（rawStockKey 相同，归档的也算）就用它，归档的自动恢复；
   * 没有就新建。document 是哪张到货单，新建、恢复的审计里都写上。调用方负责外层事务。
   */
  rawStockFor(item: RawItem, who: Actor | null | undefined, document?: string) {
    const actor = businessActor(who),
      match = this.rawStockMatch(item);
    if (!match)
      return this.saveItem({ ...item, kind: 'raw', productId: null }, actor, undefined, {
        reason: '到货入库时自动新建',
        document,
      });
    return this.restoredForUse(match.id, actor, '到货入库', document).item;
  }
  /**
   * 到货行没选库存品时会入到哪个已有的原材料（rawStockKey 相同，归档的也算）；没有返回 null。只读不写：
   * 核对入库的预览用它说清“入到已有的哪个 / 会自动恢复 / 要新建”，实际入库（rawStockFor）用的也是它，两边一致。
   */
  rawStockMatch(item: RawIdentity): { id: number; name: string; archived: boolean; balanceUnits: number } | null {
    const row = one(this.store.db, rows.stock_items.pick({ id: true }), 'SELECT id FROM stock_items WHERE raw_key=?', rawStockKey(item));
    if (!row) return null;
    const found = this.repo.items(true, row.id)[0];
    return { id: found.id, name: found.name, archived: found.archived, balanceUnits: found.balanceUnits };
  }
  /** 要往归档的库存品里入库：先恢复（和“恢复”按钮一样只去掉归档标记），审计里写明是哪件事、哪张单据自动恢复的 */
  private restoredForUse(id: number, actor: Actor, reason: string, document?: string) {
    const restored = this.store.archived('stock_items', id);
    if (restored) {
      const before = this.repo.items(true, id)[0];
      this.store.unarchive('stock_items', id);
      audit(this.store, actor, {
        action: 'restore',
        entity: 'stock_items',
        id,
        document: {
          reason: reason + '时自动恢复已归档的库存品',
          document: document ?? null,
          before,
          beforeArchived: true,
          afterArchived: false,
        },
      });
    }
    return { item: this.repo.items(true, id)[0], restored };
  }
}
