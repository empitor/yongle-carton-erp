import { z } from 'zod';
import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import { ImportError } from '../import/errors.js';
import type { RecordEntity } from '../../shared/operations.js';
import { FlowService } from '../flow/service.js';
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
        acknowledged: z.literal(true).optional(),
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
  for (const item of input.items) {
    store.db.exec('SAVEPOINT lifecycle');
    try {
      const row = store[entity](true).find((r) => r.id === item.id) as any;
      if (!row) throw new ImportError('记录不存在。', 404);
      if (row.version !== item.version) throw new ImportError('记录已修改，请刷新。', 409);
      const archived = store.archived(entity, item.id);
      if ((input.action === 'archive') === archived) {
        store.db.exec('RELEASE lifecycle');
        results.push({ id: item.id, success: true, message: archived ? '已经归档' : '已经恢复' });
        continue;
      }
      if (input.action === 'archive') {
        const reference =
          entity === 'stock_items'
            ? 'stock_id'
            : entity === 'purchases'
              ? 'purchase_id'
              : entity === 'orders'
                ? 'order_id'
                : null;
        if (
          reference &&
          store.db
            .prepare(
              'SELECT 1 FROM flow_refs r JOIN flow_documents d ON d.id=r.document_id WHERE r.' +
                reference +
                "=? AND d.status='draft' LIMIT 1",
            )
            .get(item.id)
        )
          throw new ImportError('仍有尚未处理的关联草稿，不能归档；删除采用独立的关联处理规则。');
        if (entity === 'orders' && !['草稿', '已发货', '已取消'].includes(row.status))
          throw new ImportError('订单尚未履行完成，不能归档。删除是独立的物理删除操作，仍可使用。');
        if (
          entity === 'purchases' &&
          row.baseStatus !== '已取消' &&
          row.lines.some((l: any) => l.receivedUnits < l.quantityUnits)
        )
          throw new ImportError('采购仍有未处理的订货或到货，不能归档；删除功能仍可使用。');
        if (entity === 'stock_items') {
          if (row.balanceUnits !== 0)
            throw new ImportError('库存不为零，不能归档；可以独立执行删除。');
          if (
            row.kind === 'finished' &&
            row.productId &&
            new FlowService(store)
              .list('task', true)
              .some(
                (t) =>
                  t.productId === row.productId &&
                  t.status === 'confirmed' &&
                  Number(t.completed || 0) < Number(t.quantity),
              )
          )
            throw new ImportError('该成品仍有未完成的生产任务，不能归档；删除功能仍可使用。');
          if (
            store.db
              .prepare(
                "SELECT 1 FROM purchase_lines l JOIN purchases p ON p.id=l.purchase_id WHERE l.stock_item_id=? AND l.received_units<l.quantity_units AND p.status!='已取消' LIMIT 1",
              )
              .get(item.id)
          )
            throw new ImportError('库存档案仍有未完成采购，不能归档；删除功能仍可使用。');
        }
        store.db
          .prepare('INSERT INTO record_lifecycle VALUES(?,?,?,?)')
          .run(entity, item.id, new Date().toISOString(), actor.id);
      } else
        store.db
          .prepare('DELETE FROM record_lifecycle WHERE entity=? AND record_id=?')
          .run(entity, item.id);
      audit(store, actor, 'business-management', input.action, entity, item.id, {
        before: row,
        beforeArchived: archived,
        afterArchived: !archived,
      });
      store.db.exec('RELEASE lifecycle');
      results.push({
        id: item.id,
        success: true,
        message: input.action === 'archive' ? '已归档，记录仍保存在业务表中' : '已恢复归档记录',
      });
    } catch (e) {
      store.db.exec('ROLLBACK TO lifecycle; RELEASE lifecycle');
      results.push({
        id: item.id,
        success: false,
        message: e instanceof Error ? e.message : '保存失败',
      });
    }
  }
  return { results };
}
