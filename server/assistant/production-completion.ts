import type { TaskMemory } from '../../shared/assistant-task.js';
import { confirmedValue } from './task-memory.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../db.js';
import type { Actor } from '../auth.js';
import { requirePermission, audit } from '../business/management.js';
import { FlowService } from '../flow/service.js';
import { ImportError } from '../import/errors.js';
import { productionCompletionSchema } from '../../shared/assistant-production.js';
import { quantityUnits, quantityString } from '../../shared/operations.js';
import { today } from '../../shared/domain.js';

// 复合编排只调用原生产/库存服务。整批先在回滚预演内预检，再由同一事务正式提交。
export class ProductionCompletion {
  readonly flow: FlowService;
  constructor(
    readonly store: Store,
    readonly memory?: TaskMemory,
  ) {
    this.flow = new FlowService(store);
  }
  execute(raw: unknown, who: Actor, binding: string) {
    const actor = requirePermission(who, 'business:edit'),
      v = productionCompletionSchema.parse(raw);
    if (
      this.memory?.decisions.some(
        (d) =>
          [
            'materialIssuedTotal',
            'materialReturnedTotal',
            'goodRatePct',
            'allocationMode',
          ].includes(d.key) && d.status === 'conflict',
      )
    )
      throw new ImportError(
        '当前任务的实际产量或领料规则有相互矛盾的用户决定，须先澄清真实业务事实。',
        409,
      );
    if (
      confirmedValue(this.memory, 'allocationMode') === 'per-product' &&
      v.allocation === 'shared-proportional'
    )
      throw new ImportError(
        '已确认按型号独立取整，不能改用整批共享分配；规则改变须由用户明确更正。',
        409,
      );
    for (const [key, field] of [
      ['materialIssuedTotal', 'issued'],
      ['materialReturnedTotal', 'returned'],
    ] as const) {
      const confirmed = confirmedValue(this.memory, key);
      if (
        confirmed !== undefined &&
        v.materials.reduce((n, m) => n + BigInt(quantityUnits(m[field])), 0n) !==
          BigInt(quantityUnits(String(confirmed)))
      )
        throw new ImportError(
          '完工方案与用户已确认的整批领退料数量不一致；请按已确认数量修正，不需重复询问。',
          409,
        );
    }
    const quality = confirmedValue(this.memory, 'goodRatePct');
    if (quality !== undefined && v.goodRatePct !== undefined && quality !== v.goodRatePct)
      throw new ImportError('完工良品率与用户已确认信息不一致。', 409);
    const requestId = v.requestId || randomUUID(),
      digest = createHash('sha256')
        .update(JSON.stringify({ v, actor: actor.id, binding }))
        .digest('hex');
    const prior = this.store.db
      .prepare(
        "SELECT digest,result FROM operation_requests WHERE kind='assistant-production-completion' AND request_id=?",
      )
      .get(requestId);
    if (prior) {
      if (prior.digest !== digest) throw new ImportError('完工请求编号已用于不同内容。', 409);
      return JSON.parse(String(prior.result));
    }
    const all = this.flow.list('task'),
      tasks = v.allActive
        ? all.filter(
            (t) =>
              ['draft', 'confirmed'].includes(t.status) &&
              quantityUnits(t.completed) < quantityUnits(t.quantity),
          )
        : v.taskIds!.map((id) => all.find((t) => t.id === id));
    if (
      !tasks.length ||
      tasks.some(
        (t) =>
          !t ||
          !['draft', 'confirmed'].includes(t.status) ||
          quantityUnits(t.completed) >= quantityUnits(t.quantity),
      )
    )
      throw new ImportError('所选生产任务不存在、已完工或不可执行，请重新查询。', 409);
    if (new Set(tasks.map((t) => t.id)).size !== tasks.length)
      throw new ImportError('生产任务重复。');
    if (
      v.quantities?.some((q) => !tasks.some((t) => t.id === q.taskId)) ||
      new Set(v.quantities?.map((q) => q.taskId)).size !== (v.quantities?.length || 0)
    )
      throw new ImportError('实际产量必须逐项对应本批任务。');
    if (
      v.finishedStocks &&
      (new Set(v.finishedStocks.map((s) => s.taskId)).size !== v.finishedStocks.length ||
        v.finishedStocks.some((s) => !tasks.some((t) => t.id === s.taskId)))
    )
      throw new ImportError('成品档案选择必须属于当前任务且不重复。');
    const rows = tasks.map((task) => {
      const q = v.quantities?.find((q) => q.taskId === task.id),
        remaining = quantityUnits(task.quantity) - quantityUnits(task.completed);
      // 未传良品率且未传实际产量时按100%处理；不能把缺省值当成“非100%”拒绝。
      const rate = v.goodRatePct ?? (q ? undefined : 100);
      if (!q && rate !== 100)
        throw new ImportError(
          '良品率不是100%时，须提供实际良品、废品数量，不能猜测投入量和舍入。',
          409,
        );
      const good = q ? quantityUnits(q.goodQuantity) : remaining,
        scrap = q ? quantityUnits(q.scrapQuantity) : 0;
      if (q && v.goodRatePct !== undefined) {
        const total = good + scrap,
          actual = total ? Number(((good * 100) / total).toFixed(4)) : 100;
        if (Math.abs(actual - v.goodRatePct) > 0.01)
          throw new ImportError(
            `良品率与实际良品/废品数量不一致（按实际产量为${actual.toFixed(2)}%），请核对。`,
            409,
          );
      }
      if (rate === 100 && scrap !== 0)
        throw new ImportError('100%良品与非零废品数量矛盾，请核对实际产量。', 409);
      if (!good || good > remaining)
        throw new ImportError('实际良品必须为正且不得超过当前剩余任务，请核对真实产量。', 409);
      return {
        task,
        good,
        scrap,
        materials: [] as { stockId: number; issued: string; returned: string }[],
      };
    });
    if (v.allocation === 'shared-proportional' && new Set(tasks.map((t) => t.unit)).size !== 1)
      throw new ImportError('不同成品数量单位不能按比例混算共享原料，请提供实际逐任务分配。', 409);
    const items = this.flow.ops.repo.items(),
      purchases = this.store.purchases();
    const orderIds = new Set(tasks.flatMap((t) => t.orderIds));
    const linked = new Set(
      purchases
        .filter((p) => orderIds.has(p.customerOrderId))
        .flatMap((p) => p.lines.map((l: any) => l.stockItemId)),
    );
    const materials = v.materials.map((m) => {
      const matches = items.filter(
        (i) =>
          i.kind === 'raw' &&
          i.unit === m.unit &&
          (m.stockId ? i.id === m.stockId : linked.has(i.id)),
      );
      if (matches.length !== 1)
        throw new ImportError(
          '原料未唯一匹配，请查询关联采购及规格；存在多种原料时才需要选择。',
          409,
        );
      const issued = quantityUnits(m.issued),
        returned = quantityUnits(m.returned);
      if (issued % 1000 || returned % 1000 || returned > issued)
        throw new ImportError('生产领退料须整张，退料不得超过领料。');
      if (issued > this.flow.ops.repo.balance(matches[0].id))
        throw new ImportError('原料库存不足，整批未提交。', 409);
      return { stockId: matches[0].id, issued, returned };
    });
    if (new Set(materials.map((m) => m.stockId)).size !== materials.length)
      throw new ImportError('同一原料不能重复声明。');
    if (v.allocation === 'explicit') {
      if (
        v.distribution?.length !== rows.length ||
        new Set(v.distribution.map((d) => d.taskId)).size !== rows.length
      )
        throw new ImportError('逐任务分配必须完整且不重复。');
      for (const row of rows) {
        const d = v.distribution.find((d) => d.taskId === row.task.id);
        if (!d) throw new ImportError('缺少任务原料分配。');
        row.materials = d.materials;
      }
    } else {
      // 用户明确整批实际领用量时，按产量比例、最大余数法分配整张；保留整批总量，不逐型号向上取整。
      const total = rows.reduce((n, r) => n + (BigInt(r.good) + BigInt(r.scrap)), 0n);
      for (const material of materials) {
        const distribute = (units: number) => {
          const sheets = BigInt(units / 1000),
            parts = rows.map((r, index) => {
              const value = sheets * (BigInt(r.good) + BigInt(r.scrap));
              return { index, n: value / total, remainder: value % total };
            });
          let left = sheets - parts.reduce((n, p) => n + p.n, 0n);
          for (const p of [...parts].sort((a, b) =>
            a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
          )) {
            if (left-- <= 0n) break;
            p.n++;
          }
          return parts.map((p) => Number(p.n) * 1000);
        };
        const net = distribute(material.issued - material.returned),
          returned = distribute(material.returned);
        rows.forEach((r, i) => {
          if (net[i] + returned[i] > 0)
            r.materials.push({
              stockId: material.stockId,
              issued: quantityString(net[i] + returned[i]),
              returned: quantityString(returned[i]),
            });
        });
      }
    }
    for (const material of materials)
      for (const field of ['issued', 'returned'] as const) {
        const sum = rows.reduce(
          (n, r) =>
            n +
            r.materials
              .filter((m) => m.stockId === material.stockId)
              .reduce((n, m) => n + quantityUnits(m[field]), 0),
          0,
        );
        if (sum !== material[field])
          throw new ImportError('逐任务领退料总数与整批实际数量不一致。', 409);
      }
    if (
      rows.some(
        (r) =>
          !r.materials.length ||
          r.materials.some((m) => !materials.some((x) => x.stockId === m.stockId)),
      )
    )
      throw new ImportError(
        '分配须对应实际原料，每张生产登记至少一项实际领料；请提供实际共享领料归属。',
        409,
      );
    const savepoint = 'assistant_production_completion';
    this.store.db.exec('SAVEPOINT ' + savepoint);
    try {
      let writes = 0;
      const results = rows.map((row) => {
        let task = row.task;
        if (task.status === 'draft') {
          const preview = this.flow.preview(task.id, actor, binding);
          this.flow.confirm(
            task.id,
            { previewId: preview.previewId, requestId: randomUUID(), acknowledged: true },
            actor,
            binding,
          );
          writes++;
          task = this.flow.get(task.id);
        }
        const product = this.store.product(task.productId);
        if (!product) throw new ImportError('关联产品不可用。', 409);
        const selected = v.finishedStocks?.find((s) => s.taskId === task.id)?.stockId;
        const candidates = this.flow.ops.repo
          .items()
          .filter(
            (i) =>
              i.kind === 'finished' &&
              i.productId === task.productId &&
              i.unit === task.unit &&
              (!selected || i.id === selected),
          );
        if (selected && !candidates.length)
          throw new ImportError('指定成品档案的产品或单位与生产任务不一致。', 409);
        if (candidates.length > 1)
          throw new ImportError('产品存在多个同单位成品档案，请核对规格后选择。', 409);
        let finished = candidates[0];
        if (!finished) {
          if (!v.createMissingFinished) throw new ImportError('缺少成品库存档案。', 409);
          finished = this.flow.ops.saveItem(
            {
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
            actor,
          );
          writes++;
        }
        const draft = this.flow.save(
          'production',
          {
            taskId: task.id,
            productId: product.id,
            finishedStockId: finished.id,
            date: v.date || today(),
            goodQuantity: quantityString(row.good),
            scrapQuantity: quantityString(row.scrap),
            operator: v.operator || actor.name,
            materials: row.materials,
          },
          actor,
        );
        const preview = this.flow.preview(draft.id, actor, binding);
        const saved = this.flow.confirm(
          draft.id,
          { previewId: preview.previewId, requestId: randomUUID(), acknowledged: true },
          actor,
          binding,
        );
        writes += 2;
        const actual = this.flow.get(saved.id);
        if (
          actual.status !== 'confirmed' ||
          actual.taskId !== task.id ||
          quantityUnits(actual.goodQuantity) !== row.good
        )
          throw new ImportError('正式生产回执核验失败。', 409);
        return {
          taskId: task.id,
          productionId: actual.id,
          number: actual.number,
          finishedStockId: finished.id,
          goodQuantity: actual.goodQuantity,
          scrapQuantity: actual.scrapQuantity,
          materials: actual.materials,
          verified: true,
        };
      });
      if (this.store.db.prepare('PRAGMA foreign_key_check').all().length)
        throw new ImportError('完工关联检查失败。', 409);
      const result = {
        count: writes,
        results,
        materials: materials.map((m) => ({
          stockId: m.stockId,
          issued: quantityString(m.issued),
          returned: quantityString(m.returned),
        })),
        allocation: v.allocation,
        allocationBasis:
          v.allocation === 'shared-proportional'
            ? '按实际产量比例以最大余数法分配整张领料；表示领料归属，不推断切割布局'
            : '用户明确逐任务分配',
        verified: true,
        message: `已正式完工入库${results.length}个生产任务`,
      };
      this.store.db
        .prepare('INSERT INTO operation_requests VALUES(?,?,?,?)')
        .run('assistant-production-completion', requestId, digest, JSON.stringify(result));
      this.store.db.exec('RELEASE ' + savepoint);
      return result;
    } catch (e) {
      this.store.db.exec('ROLLBACK TO ' + savepoint + '; RELEASE ' + savepoint);
      audit(this.store, actor, 'assistant-production', 'failed-completion', 'production', null, {
        requestId,
        message: e instanceof Error ? e.message : '完工失败',
      });
      throw e;
    }
  }
}
