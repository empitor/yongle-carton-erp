import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './db.js';
import type { Actor } from './auth.js';
import { requireDeveloper } from './developer-capability.js';
import {
  developerCommandSchema,
  developerModules,
  developerTemplate,
} from '../shared/developer.js';
import { customerSchema, productSchema, orderSchema } from '../shared/domain.js';
import { supplierSchema, purchaseSchema, stockItemSchema } from '../shared/operations.js';
import { flowKinds, flowInput, type FlowKind } from '../shared/physical-flow.js';
import { createBusinessService } from './business/service.js';
import { reviewedAssistantGrant } from './business/assistant-approval.js';
import { changeLifecycle, audit } from './business/management.js';
import { PermanentDeletionService } from './business/permanent-deletion.js';
import { OperationsService } from './operations/service.js';
import { FlowService } from './flow/service.js';
import { ImportError } from './import/errors.js';

import { DatabaseMaintenanceService } from './business/database-maintenance.js';
import { isLocalAdministrator } from './developer-capability.js';
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const schemas: any = {
  customers: customerSchema,
  products: productSchema,
  orders: orderSchema,
  suppliers: supplierSchema,
  purchases: purchaseSchema,
  stock_items: stockItemSchema,
};
export class DeveloperService {
  readonly ops: OperationsService;
  readonly flow: FlowService;
  constructor(readonly store: Store) {
    this.ops = new OperationsService(store);
    this.flow = new FlowService(store);
  }
  list(module: string, who: Actor | null | undefined) {
    requireDeveloper(who);
    z.enum(developerModules).parse(module);
    const rows = this.isFlow(module)
      ? this.flow.list(module as FlowKind, true)
      : this.store[
          module as keyof Pick<
            Store,
            'customers' | 'products' | 'orders' | 'suppliers' | 'purchases' | 'stock_items'
          >
        ](true);
    return {
      module,
      template: developerTemplate(
        module,
        new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }),
      ),
      records: rows.map((record: any) => ({ record, input: this.input(module, record) })),
    };
  }
  private isFlow(module: string) {
    return (flowKinds as readonly string[]).includes(module);
  }
  private input(module: string, record: any) {
    return this.isFlow(module)
      ? flowInput(module as FlowKind, record)
      : schemas[module].parse({
          ...record,
          ...(module === 'purchases' ? { status: record.baseStatus } : {}),
        });
  }
  execute(
    raw: unknown,
    who: Actor | null | undefined,
    binding: string,
    origin: 'developer-ui' | 'developer-assistant' = 'developer-ui',
  ) {
    const actor = requireDeveloper(who),
      v = developerCommandSchema.parse(raw);
    if (!binding) throw new ImportError('会话无效。', 403);
    if (isLocalAdministrator(actor) && ['delete', 'permanent-delete'].includes(v.action))
      return new DatabaseMaintenanceService(this.store).delete(
        {
          module: v.module,
          items: v.items,
          inventoryPolicy: v.inventoryPolicy,
          requestId: v.requestId,
          deletionDigest: v.deletionDigest,
        },
        actor,
        binding,
      );
    if ((v.action === 'create') !== !v.items.length)
      throw new ImportError('创建不选择旧记录，其他操作必须明确选定记录。');
    if (new Set(v.items.map((i) => i.id)).size !== v.items.length)
      throw new ImportError('记录重复。');
    const key = digest({ actor: actor.id, binding, origin, ...v }),
      prior = this.store.db
        .prepare(
          "SELECT digest,result FROM operation_requests WHERE kind='developer-edit' AND request_id=?",
        )
        .get(v.requestId);
    if (prior) {
      if (prior.digest !== key) throw new ImportError('请求编号已用于其他内容。', 409);
      return JSON.parse(String(prior.result));
    }
    this.store.db.exec('SAVEPOINT developer_edit');
    try {
      const all = this.list(v.module, actor).records,
        results = [];
      const save = (
        id: number | undefined,
        input: any,
        patch: Record<string, unknown> = v.patch,
      ) => {
        const normalized = this.isFlow(v.module)
          ? flowInput(v.module as FlowKind, input)
          : schemas[v.module].parse(input);
        const unknown = Object.keys(patch).filter((key) => !Object.hasOwn(normalized, key));
        if (unknown.length)
          throw new ImportError(
            '不支持修改字段：' +
              unknown.join('、') +
              '。库存数量请登记盘点，状态请使用确认/冲销操作。',
          );
        if (['customers', 'products', 'orders'].includes(v.module))
          return createBusinessService(this.store).execute(
            {
              entity: v.module as any,
              action: id ? 'update' : 'create',
              ...(id ? { id } : {}),
              input,
            } as any,
            {
              source: origin === 'developer-assistant' ? 'reviewed-assistant' : 'manual-ui',
              ...(origin === 'developer-assistant'
                ? { approval: reviewedAssistantGrant(actor.id) }
                : {}),
              operatorId: actor.id,
              superAdminMode: true,
              developerActor: actor,
            },
          );
        if (v.module === 'suppliers') return this.ops.saveSupplier(input, actor, id);
        if (v.module === 'purchases') return this.ops.savePurchase(input, actor, id);
        if (v.module === 'stock_items') return this.ops.saveItem(input, actor, id);
        return this.saveFlow(v.module as FlowKind, input, actor, binding, id);
      };
      if (v.action === 'create') results.push(save(undefined, v.patch));
      for (const item of v.items) {
        const selected = all.find((x) => x.record.id === item.id),
          before = selected?.record;
        if (!before || before.version !== item.version)
          throw new ImportError('记录已变化，请刷新。', 409);
        let result: any;
        if (v.action === 'update') {
          const patch = { ...v.patch, ...v.patches?.[String(item.id)] };
          result = save(item.id, { ...selected!.input, ...patch, version: item.version }, patch);
        } else if (v.action === 'move') {
          if (v.module !== 'stock_items') throw new ImportError('仅库存档案可登记库存调整。');
          result = this.ops.move(
            item.id,
            {
              ...v.patch,
              expectedVersion: item.version,
              requestId: randomUUID(),
              acknowledged: true,
            },
            actor,
          );
        } else if (this.isFlow(v.module)) {
          if (v.action === 'confirm') {
            const preview = this.flow.preview(item.id, actor, binding);
            result = this.flow.confirm(
              item.id,
              { previewId: preview.previewId, requestId: randomUUID(), acknowledged: true },
              actor,
              binding,
            );
          } else if (v.action === 'reverse')
            result = this.flow.reverse(
              item.id,
              { version: item.version, reason: v.reason, acknowledged: true },
              actor,
            );
          else if (v.action === 'cancel')
            result = this.flow.cancel(
              item.id,
              { version: item.version, reason: v.reason, acknowledged: true },
              actor,
            );
          else if (v.action === 'permanent-delete')
            result = this.deleteFlow(item.id, item.version, actor, v.reason);
          else {
            result = this.flow.archive(
              item.id,
              v.action === 'restore',
              actor,
              this.flow.get(item.id).version,
            );
          }
        } else if (v.action === 'permanent-delete') {
          const deletion = new PermanentDeletionService(this.store),
            preview = deletion.preview({ entity: v.module, items: [item] }, actor, binding);
          result = deletion.execute(
            { previewId: preview.id, acknowledged: true, confirmation: '永久删除' },
            actor,
            binding,
          );
        } else if (v.action === 'archive' || v.action === 'restore') {
          result = changeLifecycle(
            this.store,
            v.module as any,
            { action: v.action, acknowledged: true, items: [item] },
            actor,
          );
          if (result.results.some((r: any) => !r.success))
            throw new ImportError(result.results.map((r: any) => r.message).join('；'), 409);
        } else throw new ImportError('该模块不支持此操作。');
        audit(
          this.store,
          actor,
          actor.localAdministrator ? 'local-administrator' : 'local-developer',
          v.action,
          v.module,
          item.id,
          {
            reason: v.reason,
            before,
            result,
            requestId: v.requestId,
            origin,
          },
        );
        results.push(result);
      }
      if (!v.items.length)
        audit(
          this.store,
          actor,
          actor.localAdministrator ? 'local-administrator' : 'local-developer',
          v.action,
          v.module,
          results[0]?.id || null,
          {
            reason: v.reason,
            result: results[0],
            requestId: v.requestId,
            origin,
          },
        );
      if (this.store.db.prepare('PRAGMA foreign_key_check').all().length)
        throw new ImportError('关联校验失败，全部回滚。', 409);
      const response = { module: v.module, action: v.action, count: results.length, results };
      this.store.db
        .prepare('INSERT INTO operation_requests VALUES(?,?,?,?)')
        .run('developer-edit', v.requestId, key, JSON.stringify(response));
      this.store.db.exec('RELEASE developer_edit');
      return response;
    } catch (e) {
      this.store.db.exec('ROLLBACK TO developer_edit; RELEASE developer_edit');
      audit(this.store, actor, 'local-developer', 'failed-' + v.action, v.module, null, {
        requestId: v.requestId,
        origin,
        items: v.items,
        message: e instanceof Error ? e.message : '校验失败',
      });
      throw e;
    }
  }
  private saveFlow(kind: FlowKind, input: any, actor: Actor, binding: string, id?: number) {
    if (!id) return this.flow.save(kind, input, actor);
    const old = this.flow.get(id);
    if (isLocalAdministrator(actor)) return this.flow.maintenanceUpdate(id, input, actor);
    if (old.kind !== kind) throw new ImportError('单据类型不匹配。', 409);
    if (old.status === 'confirmed' && kind !== 'task') {
      const metadata = ['notes', 'operator', 'address', 'contact', 'phone'];
      const physical = (v: any) =>
        Object.fromEntries(
          Object.entries(flowInput(kind, v)).filter(([k]) => !metadata.includes(k)),
        );
      if (digest(physical(input)) === digest(physical(old)))
        return this.flow.updateMetadata(id, input, actor);
    }
    if (kind === 'task' && old.status === 'confirmed')
      return this.flow.developerUpdateTask(id, input, actor);
    if (old.status === 'draft') {
      if (old.archived) this.flow.archive(id, true, actor, old.version);
      return this.flow.save(kind, { ...input, version: this.flow.get(id).version }, actor, id);
    }
    // 实物单据通过原引擎反向流水+更正单，不能直接篡改库存或历史流水。
    if (old.status === 'confirmed')
      this.flow.reverse(
        id,
        { version: old.version, reason: '管理员编辑更正', acknowledged: true },
        actor,
      );
    if (kind === 'task') {
      const completed = this.flow.get(id).completed || '0';
      if (Number(input.quantity) < Number(completed))
        throw new ImportError('任务数量不能少于实际完工数量。');
    }
    const next = this.flow.save(
      kind,
      {
        ...input,
        correctionOf: this.flow.get(id).status === 'reversed' ? id : null,
        requestId: randomUUID(),
      },
      actor,
    );
    if (old.status === 'confirmed') {
      const p = this.flow.preview(next.id, actor, binding);
      return this.flow.confirm(
        next.id,
        { previewId: p.previewId, requestId: randomUUID(), acknowledged: true },
        actor,
        binding,
      );
    }
    return next;
  }
  private deleteFlow(id: number, version: number, actor: Actor, reason: string) {
    const doc = this.flow.get(id);
    if (doc.version !== version) throw new ImportError('单据已变化。', 409);
    if (
      this.store.db
        .prepare('SELECT 1 FROM flow_refs WHERE task_id=? AND document_id!=?')
        .get(id, id)
    )
      throw new ImportError('仍有生产记录引用此任务，请先处理关联记录。', 409);
    const corrections = this.flow.list(undefined, true).filter((d) => d.correctionOf === id);
    if (corrections.length)
      throw new ImportError(
        '更正单' +
          corrections.map((d) => d.number).join('、') +
          '仍引用本单据。请保留本单据追溯，或先处理这些更正单。',
        409,
      );
    if (doc.status === 'confirmed')
      this.flow.reverse(id, { version, reason, acknowledged: true }, actor);
    // 原件、收货历史、不可变库存流水与完整操作审计保留。移除的单据用永久删除凭据追溯。
    for (const table of ['flow_refs', 'flow_previews', 'flow_receipt_keys', 'flow_file_uses'])
      this.store.db.prepare('DELETE FROM ' + table + ' WHERE document_id=?').run(id);
    this.store.db
      .prepare('DELETE FROM record_lifecycle WHERE entity=? AND record_id=?')
      .run('flow_' + doc.kind, id);
    this.store.db.prepare('DELETE FROM flow_documents WHERE id=?').run(id);
    this.store.db
      .prepare('INSERT OR REPLACE INTO permanent_record_deletions VALUES(?,?,?,?,?)')
      .run('flow_' + doc.kind, id, new Date().toISOString(), actor.id, doc.number);
    return { id, number: doc.number, permanentlyDeleted: true };
  }
}
