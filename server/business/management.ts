import { z } from 'zod';
import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import { ImportError } from '../import/errors.js';
import type { RecordEntity } from '../../shared/operations.js';
import { flowReference } from '../flow/service.js';
export function requirePermission(actor: Actor | null | undefined, permission: string): Actor {
  if (!actor) throw new ImportError('请先登录管理账号。', 401, 'authentication');
  if (isSuperMode(actor)) return actor;
  if (!actor.permissions.includes(permission))
    throw new ImportError('当前账号没有执行此操作的权限。', 403, 'permission');
  return actor;
}
export function isSuperMode(actor: Actor | null | undefined) {
  return (
    !!actor &&
    actor.role === 'super_admin' &&
    actor.superAdminMode === true &&
    (actor.superAdminUntil || 0) > Date.now()
  );
}
export function audit(
  store: Store,
  actor: Actor,
  source: string,
  action: string,
  entity: string,
  id: number | null,
  document: unknown,
) {
  store.db
    .prepare(
      'INSERT INTO business_audit(at,actor_id,actor_name,source,action,entity,record_id,document) VALUES(?,?,?,?,?,?,?,?)',
    )
    .run(
      new Date().toISOString(),
      actor.id,
      actor.name,
      source,
      action,
      entity,
      id,
      JSON.stringify(document),
    );
}
export function changeLifecycle(
  store: Store,
  entity: RecordEntity,
  raw: unknown,
  who: Actor | null | undefined,
) {
  const actor = requirePermission(who, 'business:edit'),
    input = z
      .strictObject({
        action: z.enum(['archive', 'restore']),
        acknowledged: z.literal(true),
        items: z
          .array(
            z.strictObject({
              id: z.number().int().positive(),
              version: z.number().int().positive(),
            }),
          )
          .min(1)
          .max(1000),
      })
      .parse(raw);
  if (new Set(input.items.map((i) => i.id)).size !== input.items.length)
    throw new ImportError('记录重复。');
  const results = [];
  const records = new Map(store[entity](true).map((row) => [row.id, row]));
  for (const item of input.items) {
    store.db.exec('SAVEPOINT lifecycle');
    try {
      const row = records.get(item.id);
      if (!row) throw new ImportError('记录不存在。', 404);
      if (row.version !== item.version)
        throw new ImportError('记录已修改，请刷新后重新确认。', 409);
      const archived = store.archived(entity, item.id);
      if (
        input.action === 'archive' &&
        ['orders', 'purchases', 'stock_items'].includes(entity) &&
        flowReference(store, entity, item.id)
      )
        throw new ImportError(
          '记录已关联到货、生产或送货单，请保留业务链路；先处理相关草稿或冲销，历史单据不直接删除。',
        );
      if (input.action === 'archive' && entity === 'stock_items') {
        if ((row as any).balanceUnits !== 0)
          throw new ImportError('库存不为零，不能隐藏库存品；请先出库或按实际盘点调整为零。');
        if (
          store.db
            .prepare(
              "SELECT 1 FROM purchase_lines pl JOIN purchases p ON p.id=pl.purchase_id WHERE pl.stock_item_id=? AND pl.received_units<pl.quantity_units AND p.status!='已取消' LIMIT 1",
            )
            .get(item.id)
        )
          throw new ImportError('库存品仍有关联未完成采购，请先完成或取消采购。');
      }
      if (
        input.action === 'archive' &&
        entity === 'orders' &&
        (store.db
          .prepare('SELECT 1 FROM purchases WHERE customer_order_id=? LIMIT 1')
          .get(item.id) ||
          store.db
            .prepare('SELECT 1 FROM stock_movements WHERE customer_order_id=? LIMIT 1')
            .get(item.id))
      )
        throw new ImportError('订单已有采购或库存流水关联，请保留历史订单；先核对相关业务。');
      if (
        input.action === 'archive' &&
        entity === 'purchases' &&
        (row as any).status === '部分到货' &&
        !isSuperMode(actor)
      )
        throw new ImportError('采购单还有未到货部分，请先完成到货或取消剩余订货，再移入回收站。');
      const references =
        entity === 'customers'
          ? Number(
              store.db.prepare('SELECT COUNT(*) n FROM orders WHERE customer_id=?').get(item.id)!.n,
            )
          : entity === 'products'
            ? Number(
                store.db
                  .prepare('SELECT COUNT(*) n FROM order_lines WHERE product_id=?')
                  .get(item.id)!.n,
              )
            : 0;
      if ((input.action === 'archive') === archived) {
        store.db.exec('RELEASE lifecycle');
        results.push({ id: item.id, success: true, message: archived ? '已经归档' : '已经恢复' });
        continue;
      }
      if (
        entity === 'orders' &&
        input.action === 'archive' &&
        !isSuperMode(actor) &&
        (!['草稿', '已确认', '已取消'].includes((row as any).status) ||
          !!store.db
            .prepare(
              "SELECT 1 FROM business_audit WHERE entity='orders' AND record_id=? AND (json_extract(document,'$.before.status') IN ('生产中','待发货','已发货') OR json_extract(document,'$.after.status') IN ('生产中','待发货','已发货')) LIMIT 1",
            )
            .get(item.id))
      )
        throw new ImportError(
          '订单已经进入生产、待发货或已发货，不能直接删除；请先核对后续业务并按作废流程处理。',
        );
      if (input.action === 'restore' && entity === 'orders' && !isSuperMode(actor)) {
        const order = row as any;
        if (
          store.archived('customers', order.customerId) ||
          order.lines.some((l: any) => store.archived('products', l.productId))
        )
          throw new ImportError('请先恢复订单引用的客户或产品档案。');
      }
      if (input.action === 'archive')
        store.db
          .prepare('INSERT INTO record_lifecycle VALUES(?,?,?,?)')
          .run(entity, item.id, new Date().toISOString(), actor.id);
      else
        store.db
          .prepare('DELETE FROM record_lifecycle WHERE entity=? AND record_id=?')
          .run(entity, item.id);
      audit(
        store,
        actor,
        isSuperMode(actor) ? 'super-admin' : 'business-ui',
        input.action,
        entity,
        item.id,
        {
          before: row,
          beforeArchived: archived,
          afterArchived: !archived,
          historicalReferences: references,
        },
      );
      store.db.exec('RELEASE lifecycle');
      results.push({
        id: item.id,
        success: true,
        message:
          input.action === 'archive'
            ? entity === 'orders'
              ? '已软删除，历史和审计保留'
              : references
                ? '关联' + references + '项历史引用，已停用归档，不删除历史订单'
                : '已停用归档，可恢复'
            : '已恢复',
      });
    } catch (error) {
      store.db.exec('ROLLBACK TO lifecycle; RELEASE lifecycle');
      results.push({
        id: item.id,
        success: false,
        message: error instanceof ImportError ? error.message : '保存失败，记录未改动。',
      });
    }
  }
  return { results };
}
