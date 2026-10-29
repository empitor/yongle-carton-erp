import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../db.js';
import type { Actor } from '../auth.js';
import { requirePermission } from '../business/management.js';
import { ImportError } from '../import/errors.js';
import { productionCompletionSchema } from '../../shared/assistant-production.js';
import { ProductionCompletion } from '../assistant/production-completion.js';
export class ManualProductionCompletion {
  constructor(readonly store: Store) {}
  private digest(input: any, actor: Actor, binding: string) {
    const versions = ['flow_documents', 'stock_items', 'products', 'orders'].map((t) =>
      this.store.db.prepare('SELECT id,version FROM ' + t + ' ORDER BY id').all(),
    );
    return createHash('sha256')
      .update(JSON.stringify({ input, actor: actor.id, binding, versions }))
      .digest('hex');
  }
  preview(raw: unknown, who: Actor, binding: string) {
    const actor = requirePermission(who, 'business:edit'),
      input = productionCompletionSchema.parse(raw);
    z.string().uuid().parse(input.requestId);
    const digest = this.digest(input, actor, binding);
    this.store.db.exec('SAVEPOINT manual_production_preview');
    try {
      const result = new ProductionCompletion(this.store).execute(input, actor, binding);
      return {
        ...result,
        results: result.results.map(({ productionId, number, finishedStockId, ...r }: any) => r),
        message: '预览通过，尚未登记实际完工或变更库存。',
        verified: false,
        inventoryChanged: false,
        previewDigest: digest,
      };
    } finally {
      this.store.db.exec(
        'ROLLBACK TO manual_production_preview; RELEASE manual_production_preview',
      );
    }
  }
  execute(raw: unknown, who: Actor, binding: string) {
    const actor = requirePermission(who, 'business:edit'),
      v = z
        .strictObject({
          input: productionCompletionSchema,
          previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .parse(raw);
    z.string().uuid().parse(v.input.requestId);
    if (v.input.previewOnly) throw new ImportError('仅预览请求不能登记实际完工。');
    const prior = this.store.db
      .prepare(
        "SELECT 1 FROM operation_requests WHERE kind='assistant-production-completion' AND request_id=?",
      )
      .get(v.input.requestId!);
    if (!prior && this.digest(v.input, actor, binding) !== v.previewDigest)
      throw new ImportError('生产或库存已更新，请重新预览领料与完工分配。', 409);
    return new ProductionCompletion(this.store).execute(v.input, actor, binding);
  }
}
