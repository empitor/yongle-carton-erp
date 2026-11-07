import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { z } from 'zod';
import type { ImportManager } from '../import/manager.js';
import type { MarkAi } from './mark-ai.js';
import { MarkService } from './service.js';
import { audit } from '../business/management.js';
import { ImportError } from '../import/errors.js';
import type { MarkReview } from '../../shared/shipping-mark.js';
import { matchMarkToProducts, normalizeCode } from '../../shared/mark-matching.js';
import { productSchema } from '../../shared/domain.js';
import type { AiProgress } from '../../shared/ai-runtime.js';

type Check = () => any;
const recognizeSchema = z.object({
  force: z.boolean().default(false),
  stream: z.boolean().default(false),
  policyVersion: z.number().int().optional(),
  profile: z
    .object({
      id: z.string(),
      endpoint: z.string(),
      model: z.string(),
      apiStyle: z.enum(['responses', 'chat-completions']),
    })
    .optional(),
});
const mimes: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/**
 * 唛头的目标：识别出名称、尺寸、料号，用它们对应到产品，把原文件挂到产品下面。
 * 页面和 AI 助手共用这一套，都不产生订单、生产或库存。
 */
export class MarkImportService {
  readonly service: MarkService;
  constructor(
    readonly manager: ImportManager,
    readonly ai: MarkAi,
  ) {
    this.service = new MarkService(ai.store);
  }
  workspace(id: string) {
    const w = this.manager.get(id);
    if (w.mode !== 'mark') throw new ImportError('请先将此文件切换为唛头识别。', 409);
    return w;
  }
  /** 产品以前挂过的唛头料号也算对应依据，老产品再来新唛头时能直接认出来。 */
  products() {
    const codes = new Map<number, string[]>();
    for (const row of this.ai.store.db
      .prepare("SELECT product_id,json_extract(fields,'$.itemCode') AS code FROM product_marks")
      .all() as any[])
      if (row.code) codes.set(row.product_id, [...(codes.get(row.product_id) || []), row.code]);
    return this.ai.store
      .products()
      .map(({ id, name, customerProductCode, length, width, height, dimensionUnit }) => ({
        id,
        name,
        customerProductCode,
        length,
        width,
        height,
        dimensionUnit,
        markCodes: codes.get(id) || [],
      }));
  }
  view(id: string) {
    this.workspace(id);
    const review = this.manager.markReview(id),
      all = this.products();
    return {
      review,
      candidates: Object.fromEntries(
        (review?.items || []).map((i) => [i.key, matchMarkToProducts(i.fields, all)]),
      ),
      products: all,
    };
  }
  saveItems(id: string, expectedRevision: number, items: MarkReview['items']) {
    this.workspace(id);
    const old = this.manager.markReview(id);
    if (!old) throw new ImportError('请先识别唛头。', 409);
    if (
      items.length !== old.items.length ||
      new Set(items.map((i) => i.key)).size !== old.items.length ||
      items.some((i) => !old.items.some((o) => o.key === i.key))
    )
      throw new ImportError('唛头条目与识别结果不一致。', 400);
    return this.manager.saveMarkReview(id, expectedRevision, { ...old, items });
  }
  /** 外发范围是用户确认过的那个模型。配置变了要重新确认，要在开始流式返回之前就拦住。 */
  checkProfile(raw: unknown) {
    const input = recognizeSchema.parse(raw);
    const profile = this.ai.settings.view().active;
    if (!profile?.hasApiKey || !profile.model) throw new ImportError('请先保存并启用AI预设。', 400);
    if (
      input.profile &&
      ['id', 'endpoint', 'model', 'apiStyle'].some(
        (k) => (input.profile as any)[k] !== (profile as any)[k],
      )
    )
      throw new ImportError('AI配置已变化，请重新确认外发范围。', 409);
    return { input, profile };
  }
  /** 全部对应上就直接挂到产品；有一款对不上就留给人选，选完一起挂。 */
  async recognize(
    id: string,
    raw: unknown,
    check: Check,
    hooks: {
      onSource?: (sourceId: string) => void;
      onProgress?: (p: AiProgress) => void;
    } = {},
  ) {
    const who = check(),
      w = this.workspace(id),
      { ai, manager } = this;
    if (
      manager.markReview(id)?.committed ||
      ai.store.db
        .prepare("SELECT 1 FROM operation_requests WHERE kind='mark-import' AND request_id=?")
        .get(id)
    )
      throw new ImportError('唛头已归档，不能重新识别。', 409);
    const { input, profile } = this.checkProfile(raw);
    const original = await manager.original(id);
    // 读原件要时间，这期间配置可能被改，外发前用同一个配置再核一次。
    this.checkProfile({ ...input, profile });
    const source = ai.upload(original.bytes, original.fileName, who)!;
    hooks.onSource?.(source.id);
    const result =
      source.result && !input.force
        ? source
        : await ai.analyze(
            source.id,
            { ...input, consent: true, profile },
            who,
            hooks.onProgress,
          );
    check();
    const all = this.products();
    const review: MarkReview = {
      fileHash: w.fileHash,
      recognizedAt: result!.recognizedAt,
      warnings: result!.result.warnings,
      committed: null,
      items: result!.result.marks.map(({ page, title, ...fields }: any, index: number) => {
        const recommended = matchMarkToProducts(fields, all).filter((c) => c.recommended);
        return {
          key: 'p' + page + '-' + index,
          page,
          title,
          fields,
          choice:
            recommended.length === 1
              ? { mode: 'existing', id: recommended[0].id }
              : { mode: 'pending' },
          skip: false,
        };
      }),
    };
    const saved = manager.saveMarkReview(id, w.revision, review);
    if (!review.items.length || !review.items.every((i) => i.choice.mode === 'existing'))
      return saved;
    try {
      await this.commit(id, { expectedRevision: saved.revision, requestId: randomUUID() }, check);
    } catch {
      // 自动挂失败（比如产品刚被归档）不影响识别结果，留给人在页面上处理并看到原因。
    }
    return manager.get(id);
  }
  /** 把原文件挂到选好的产品下。单事务，重复提交不会多挂。 */
  async commit(id: string, raw: unknown, check: Check) {
    const who = check(),
      w = this.workspace(id),
      { ai, manager, service } = this;
    const input = z
      .strictObject({
        expectedRevision: z.number().int().nonnegative(),
        requestId: z.string().uuid(),
      })
      .parse(raw);
    const review = manager.markReview(id);
    if (!review) throw new ImportError('请先识别唛头。', 409);
    const db = ai.store.db;
    const prior = db
      .prepare("SELECT result FROM operation_requests WHERE kind='mark-import' AND request_id=?")
      .get(id);
    if (review.committed || prior) {
      const committed = review.committed || JSON.parse(String(prior!.result));
      if (!review.committed) manager.saveMarkReview(id, w.revision, { ...review, committed });
      return committed;
    }
    if (w.revision !== input.expectedRevision) throw new ImportError('草稿已变化，请刷新。', 409);
    const reuse = db
      .prepare(
        "SELECT digest FROM operation_requests WHERE kind='mark-import-request' AND request_id=?",
      )
      .get(input.requestId);
    if (reuse && reuse.digest !== id) throw new ImportError('请求编号已用于其他工作区。', 409);
    const pending = review.items.filter((i) => !i.skip && i.choice.mode === 'pending');
    if (pending.length)
      throw new ImportError(
        '请先选择产品：' + pending.map((i) => i.title || i.key).join('、'),
        400,
      );
    const original = await manager.original(id);
    check();
    const currentReview = manager.markReview(id);
    const currentPrior = db
      .prepare("SELECT result FROM operation_requests WHERE kind='mark-import' AND request_id=?")
      .get(id);
    if (currentReview?.committed || currentPrior) {
      const committed = currentReview?.committed || JSON.parse(String(currentPrior!.result));
      if (!currentReview?.committed)
        manager.saveMarkReview(id, manager.get(id).revision, { ...currentReview!, committed });
      return committed;
    }
    if (manager.get(id).revision !== input.expectedRevision)
      throw new ImportError('草稿已变化，请刷新。', 409);
    const mime = mimes[extname(original.fileName).toLowerCase()] || 'application/octet-stream';
    db.exec('SAVEPOINT mark_commit');
    let committed: NonNullable<MarkReview['committed']>;
    try {
      // Recheck after awaiting the original: another commit may have completed meanwhile.
      const previous = db
        .prepare("SELECT result FROM operation_requests WHERE kind='mark-import' AND request_id=?")
        .get(id);
      if (previous) committed = JSON.parse(String(previous.result));
      else {
        // 同一份文件里多款选“新建”且名称相同时，只建一个产品。
        const created = new Map<string, any>();
        const results = review.items
          .filter((i) => !i.skip)
          .map((i) => {
            if (i.choice.mode === 'pending') throw new ImportError('请选择产品。', 400);
            // 同名不同料号是两个产品，不能并成一个。
            const newKey =
              i.choice.mode === 'new'
                ? normalizeCode(i.choice.name) + '|' + normalizeCode(i.choice.customerProductCode || '')
                : '';
            const isNew = i.choice.mode === 'new' && !created.has(newKey);
            const product =
              i.choice.mode === 'existing'
                ? ai.store.product(i.choice.id)
                : created.get(newKey) ||
                  ai.store.saveProduct(
                    productSchema.parse({
                      name: i.choice.name,
                      customerProductCode: i.choice.customerProductCode,
                    }),
                  );
            if (i.choice.mode === 'new') created.set(newKey, product);
            if (!product) throw new ImportError('产品不存在或已归档。', 404);
            if (isNew)
              audit(ai.store, who, 'marks', 'create-product', 'products', product.id, product);
            const mark = service.add(
              {
                productId: product.id,
                bytes: original.bytes,
                name: original.fileName,
                mime,
                page: i.page,
                title: i.title || '',
                fields: i.fields,
                sourceKind: 'ai-import',
                sourceRef: id,
              },
              who,
            );
            return { key: i.key, productId: product.id, markId: mark.id };
          });
        committed = { at: new Date().toISOString(), results };
        db.prepare('INSERT INTO operation_requests VALUES(?,?,?,?)').run(
          'mark-import',
          id,
          review.fileHash,
          JSON.stringify(committed),
        );
        db.prepare('INSERT INTO operation_requests VALUES(?,?,?,?)').run(
          'mark-import-request',
          input.requestId,
          id,
          JSON.stringify(committed),
        );
      }
      db.exec('RELEASE mark_commit');
    } catch (e) {
      db.exec('ROLLBACK TO mark_commit; RELEASE mark_commit');
      throw e;
    }
    manager.saveMarkReview(id, input.expectedRevision, { ...review, committed });
    return committed;
  }
  /** 给 AI 助手看的结果：挂到了哪个产品、哪些还要人选。不返回解析细节以外的业务数据。 */
  summary(id: string) {
    const state = this.view(id),
      review = state.review,
      w = this.manager.get(id),
      names = new Map(state.products.map((p) => [p.id, p.name]));
    const attached = (review?.committed?.results || []).map((r) => ({
      productId: r.productId,
      productName: names.get(r.productId) || '',
      markId: r.markId,
    }));
    const pending = review?.committed
      ? []
      : (review?.items || [])
          .filter((i) => !i.skip)
          .map((i) => ({
            key: i.key,
            page: i.page,
            itemCode: i.fields.itemCode,
            productName: i.fields.productName,
            size: [i.fields.cartonLength, i.fields.cartonWidth, i.fields.cartonHeight]
              .filter(Boolean)
              .join('×'),
            dimensionUnit: i.fields.dimensionUnit,
            candidates: (state.candidates[i.key] || []).slice(0, 5).map((c) => ({
              id: c.id,
              name: c.name,
              reasons: c.reasons,
              conflicts: c.conflicts,
            })),
          }));
    return {
      workspaceId: id,
      fileName: w.fileName,
      attached,
      pending,
      url: attached[0] ? '#products?q=' + encodeURIComponent(attached[0].productName) : '#ai-import?workspace=' + id,
      message: attached.length
        ? '原文件已挂到产品下，在产品详情里可以预览。'
        : pending.length
          ? '识别完成，还没对应上产品。'
          : '没有识别到唛头。',
    };
  }
}
