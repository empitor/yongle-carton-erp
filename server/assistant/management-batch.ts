import { developerNames } from '../../shared/developer.js';
import { createHash } from 'node:crypto';
import type { Store } from '../db.js';
import type { Actor } from '../auth.js';
import { requireLocalAdministrator } from '../developer-capability.js';
import { DeveloperService } from '../developer-service.js';
import { assistantManagementSchema } from '../../shared/assistant-management.js';
import { convertDimension, normalizeDimensionUnit } from '../../shared/product-details.js';
import { ImportError } from '../import/errors.js';
import type { TaskMemory } from '../../shared/assistant-task.js';
import { confirmedValue } from './task-memory.js';
import { today } from '../../shared/domain.js';
import { DatabaseMaintenanceService } from '../business/database-maintenance.js';
import { audit } from '../business/management.js';
import { quantityUnits } from '../../shared/operations.js';
const uuid = (root: string, suffix: string) => {
  const hex = createHash('sha256')
    .update(root + ':' + suffix)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
function refs(value: any, outputs: Record<string, any>): any {
  if (Array.isArray(value)) return value.map((v) => refs(v, outputs));
  if (value && typeof value === 'object') {
    if (Object.keys(value).length === 1 && typeof value.$ref === 'string') {
      const path = value.$ref.split('.');
      if (path.some((p: string) => ['__proto__', 'prototype', 'constructor'].includes(p)))
        throw new ImportError('业务引用路径非法。');
      let result: any = outputs;
      for (const key of path)
        result = result && Object.hasOwn(result, key) ? result[key] : undefined;
      if (result === undefined) throw new ImportError('前置业务结果尚不存在：' + value.$ref, 409);
      return result;
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, refs(v, outputs)]));
  }
  return value;
}
/** 仅编排原管理服务：同Actor、同事务与执行台账，不实现第二套业务写入。 */
export class AssistantManagementBatch {
  readonly service: DeveloperService;
  private dependencyWrites = 0;
  constructor(
    readonly store: Store,
    readonly memory?: TaskMemory,
  ) {
    this.service = new DeveloperService(store);
  }
  stamp(raw: unknown, actor: Actor) {
    requireLocalAdministrator(actor);
    const v = assistantManagementSchema.parse(raw);
    const commands = 'commands' in v ? v.commands : [v];
    return Object.fromEntries(
      [...new Set(commands.map((c) => c.module))].map((module) => [
        module,
        this.service.list(module, actor).records.map((x) => x.record),
      ]),
    );
  }
  execute(raw: unknown, actor: Actor, binding: string) {
    this.dependencyWrites = 0;
    requireLocalAdministrator(actor);
    const v = assistantManagementSchema.parse(raw),
      commands = 'commands' in v ? v.commands : [{ ...v, key: 'operation' }];
    const digest = createHash('sha256')
      .update(JSON.stringify({ actor: actor.id, binding, v }))
      .digest('hex');
    const prior = this.store.db
      .prepare(
        "SELECT digest,result FROM operation_requests WHERE kind='assistant-management-batch' AND request_id=?",
      )
      .get(v.requestId);
    if (prior) {
      if (prior.digest !== digest) throw new ImportError('批量请求编号已经用于其他操作。', 409);
      return JSON.parse(String(prior.result));
    }
    const outputs: Record<string, any> = {},
      results: any[] = [];
    this.store.db.exec('SAVEPOINT assistant_management_batch');
    try {
      for (const [index, source] of commands.entries()) {
        if (Object.hasOwn(outputs, source.key)) throw new ImportError('批量步骤标识重复。');
        const command = refs(source, outputs);
        if (command.module === 'production' && command.action === 'create')
          this.productionDependencies(command.patch, actor, binding, v.requestId, index);
        const records = this.service.list(command.module, actor).records;
        const items = command.selection
          ? records
              .filter(
                ({ record: r }) =>
                  (!command.selection.kind || r.kind === command.selection.kind) &&
                  (command.selection.archived === undefined ||
                    !!r.archived === command.selection.archived) &&
                  (!command.selection.q ||
                    JSON.stringify([r.name, r.number, r.specification]).includes(
                      command.selection.q,
                    )),
              )
              .map(({ record: r }) => ({ id: r.id, version: r.version }))
          : command.items || [];
        if (command.action !== 'create' && !items.length) {
          if (!command.selection) throw new ImportError('没有指定业务记录或全部选择范围。');
          outputs[source.key] = { count: 0, results: [] };
          continue;
        }
        const chunks: any[][] = [];
        if (command.action === 'create') chunks.push([]);
        else
          for (let offset = 0; offset < items.length; offset += 100)
            chunks.push(items.slice(offset, offset + 100));
        const combined: any[] = [],
          impacts: any[] = [];
        for (const [chunkIndex, chunk] of chunks.entries()) {
          const dimension =
            command.action === 'update' &&
            command.patch.dimensionUnit &&
            ['products', 'stock_items'].includes(command.module) &&
            command.dimensionPolicy !== 'relabel';
          const patch = { ...command.patch },
            patches: Record<string, Record<string, unknown>> = {};
          if (dimension)
            for (const item of chunk) {
              const before = records.find((x) => x.record.id === item.id)!.record;
              const from = normalizeDimensionUnit(before.dimensionUnit),
                to = normalizeDimensionUnit(patch.dimensionUnit);
              if (!from || !to)
                throw new ImportError(
                  '原尺寸单位未知，不能猜测换算；请明确仅更正标签或实际尺寸。',
                  409,
                );
              const each: Record<string, unknown> = {};
              for (const axis of ['length', 'width', 'height'])
                if (!Object.hasOwn(patch, axis))
                  each[axis] = convertDimension(before[axis], from, to);
              patches[String(item.id)] = each;
            }
          const impact = ['delete', 'permanent-delete'].includes(command.action)
            ? new DatabaseMaintenanceService(this.store).preview(
                { module: command.module, items: chunk, inventoryPolicy: command.inventoryPolicy },
                actor,
              )
            : undefined;
          const result = this.service.execute(
            {
              requestId: uuid(v.requestId, `${index}:${chunkIndex}`),
              module: command.module,
              action: command.action,
              items: chunk,
              patch,
              patches,
              deletionDigest: impact?.digest,
              inventoryPolicy: command.inventoryPolicy,
              reason: v.reason,
            },
            actor,
            binding,
            'developer-assistant',
          );
          if (impact)
            impacts.push({
              impact: impact.impact,
              inventoryEffect: impact.inventoryEffect,
              warning: impact.warning,
            });
          combined.push(...(result.results || []));
        }
        const output =
          combined.length === 1 ? combined[0] : { count: combined.length, results: combined };
        outputs[source.key] = output;
        results.push({
          key: source.key,
          module: command.module,
          action: command.action,
          count: combined.length,
          result: output,
          ...(impacts.length ? { impacts } : {}),
        });
      }
      if (this.store.db.prepare('PRAGMA foreign_key_check').all().length)
        throw new ImportError('批量业务关联检查失败，已整体回滚。', 409);
      const result = {
        count: results.reduce((n, r) => n + r.count, 0) + this.dependencyWrites,
        results,
        outputs,
        verified: true,
        message: results.length
          ? '已执行：' +
            results
              .map(
                (r) =>
                  (developerNames[r.module] || r.module) +
                  ({
                    create: '新增',
                    update: '更新',
                    delete: '删除',
                    'permanent-delete': '删除',
                    confirm: '确认',
                    archive: '归档',
                    restore: '恢复',
                    reverse: '冲销',
                    move: '出入库',
                    cancel: '取消',
                  }[r.action as string] || r.action) +
                  r.count +
                  '条',
              )
              .join('；')
          : '所选范围内没有需处理的业务记录',
      };
      this.store.db
        .prepare('INSERT INTO operation_requests VALUES(?,?,?,?)')
        .run('assistant-management-batch', v.requestId, digest, JSON.stringify(result));
      this.store.db.exec('RELEASE assistant_management_batch');
      return result;
    } catch (e) {
      this.store.db.exec(
        'ROLLBACK TO assistant_management_batch; RELEASE assistant_management_batch',
      );
      audit(this.store, actor, 'assistant-management', 'failed-batch', 'batch', null, {
        requestId: v.requestId,
        commands: commands.map((c) => ({ module: c.module, action: c.action })),
        message: e instanceof Error ? e.message : '批量失败',
      });
      throw e;
    }
  }
  private productionDependencies(
    patch: any,
    actor: Actor,
    binding: string,
    requestId: string,
    index: number,
  ) {
    const task = patch.taskId ? this.service.flow.get(patch.taskId) : undefined;
    if (task && task.kind !== 'task') throw new ImportError('关联对象不是生产任务。', 409);
    if (task && patch.productId && patch.productId !== task.productId)
      throw new ImportError('生产产品与任务不一致。', 409);
    patch.productId ||= task?.productId;
    const product = this.store.product(patch.productId);
    if (!product) throw new ImportError('生产产品尚未明确，应先从真实任务或订单读取。', 409);
    patch.date ||= today();
    patch.operator ||= actor.name; // 与人工生产表单相同的默认操作员。
    if (!patch.materials) {
      const rate = confirmedValue(this.memory, 'unitsPerSheet'),
        mode = confirmedValue(this.memory, 'allocationMode');
      if (typeof rate !== 'number' || mode !== 'per-product' || task?.unit !== '只')
        throw new ImportError(
          '需要明确实际领料或每张产出及按型号独立/跨型号共享规则；不会猜测材料分配。',
          409,
        );
      const stockIds = new Set(
        this.store
          .purchases()
          .filter((p) => task.orderIds.includes(p.customerOrderId))
          .flatMap((p) => p.lines.map((l: any) => l.stockItemId)),
      );
      const raw = this.service.ops.repo
        .items()
        .filter((s) => s.kind === 'raw' && s.unit === '张' && stockIds.has(s.id));
      if (raw.length !== 1)
        throw new ImportError('关联采购有多种或缺少实际原料，请明确材料规格或分配方式。', 409);
      const good = String(patch.goodQuantity ?? ''),
        scrap = String(patch.scrapQuantity || '0');
      if (!/^\d+$/.test(good) || !/^\d+$/.test(scrap))
        throw new ImportError('按张产出计算要求实际良品和废品只数为整数。', 409);
      const needed = (BigInt(good) + BigInt(scrap) + BigInt(rate) - 1n) / BigInt(rate);
      patch.materials = [{ stockId: raw[0].id, issued: String(needed), returned: '0' }];
    }
    if (!patch.finishedStockId) {
      const candidates = this.service.ops.repo
        .items()
        .filter((s) => s.kind === 'finished' && s.productId === product.id);
      if (candidates.length > 1)
        throw new ImportError('该产品有多个成品库存档案，需要按规格核对。', 409);
      if (candidates.length === 1) patch.finishedStockId = candidates[0].id;
      else {
        if (!task?.unit) throw new ImportError('成品数量单位未明确，不能猜测创建库存档案。', 409);
        const saved = this.service.execute(
          {
            requestId: uuid(requestId, `${index}:finished-stock`),
            module: 'stock_items',
            action: 'create',
            patch: {
              name: product.name,
              kind: 'finished',
              unit: task.unit,
              productId: product.id,
              specification: product.customerProductCode || '',
              length: product.length,
              width: product.width,
              height: product.height,
              dimensionUnit: product.dimensionUnit,
              material: product.material,
              flute: product.flute,
            },
            reason: '完成已授权生产任务所需的对应成品库存档案',
          },
          actor,
          binding,
          'developer-assistant',
        );
        patch.finishedStockId = saved.results[0].id;
        this.dependencyWrites++;
      }
    }
    const rate = confirmedValue(this.memory, 'unitsPerSheet'),
      mode = confirmedValue(this.memory, 'allocationMode');
    if (typeof rate === 'number' && mode === 'per-product' && task?.unit === '只') {
      const needed =
        (BigInt(String(patch.goodQuantity)) +
          BigInt(String(patch.scrapQuantity || '0')) +
          BigInt(rate) -
          1n) /
        BigInt(rate);
      const materials = patch.materials as { stockId: number; issued: string; returned?: string }[];
      const all = this.service.ops.repo.items();
      if (materials.some((m) => all.find((s) => s.id === m.stockId)?.unit !== '张'))
        throw new ImportError('按张生产规则不能与其他材料单位混算。', 409);
      const consumed = materials.reduce(
        (n, m) => n + BigInt(quantityUnits(m.issued)) - BigInt(quantityUnits(m.returned || '0')),
        0n,
      );
      if (consumed !== needed * 1000n)
        throw new ImportError(
          '实际领退料与用户确认的逐型号产出规则不一致，不能随意分摊原料。',
          409,
        );
    }
  }
}
