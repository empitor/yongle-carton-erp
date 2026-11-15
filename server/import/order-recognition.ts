import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DRAFT_NOTE_MAX,
  draftFromForm,
  orderFormSchema,
  orderFormTool,
  workspaceEnqueueSchema,
} from '../../shared/import/index.js';
import type { AiProgress } from '../../shared/ai/index.js';
import { AiConnectionError, retryBadModelOutput } from '../ai/index.js';
import type { ProviderTokenUsage } from '../ai/index.js';
import { AppError } from '../core/index.js';
import { dateSchema } from '../../shared/core/index.js';
import { analysisPrompt } from './prompts.js';
import { withSourceFile } from './source-file.js';
import type { FailureContext } from './failure-record.js';
import type { WorkspaceStore, WorkspaceView } from './workspace-store.js';
import type { Workspace } from './workspace-document.js';

/** 模型交回的表按表的定义校验、转成识别结果；一行能用的明细都没有就当不合格 */
export function usableAnalysis(filled: unknown) {
  const parsed = draftFromForm(orderFormSchema.parse(filled));
  if (!parsed.lines.some((l) => l.productName.value || l.quantity.value || l.unitPrice.value))
    throw new AppError('没有识别到可用订单明细，请核对原文件是否清楚、是不是订单。', 422, 'model-schema');
  return parsed;
}

/**
 * 原件没写整单交期、每行都有明确交期时，整单交期取最晚的一行，标成待核对并写明出处。
 * 订单明细自己存交期，所以各行交期原样保留；由代码定，不让模型这次填、下次不填。
 */
export function deliveryFromLines(result: ReturnType<typeof usableAnalysis>) {
  if (result.header.deliveryDate.value) return;
  const dates = result.lines.map((l) => l.deliveryDate.value?.trim() || '');
  if (!dates.every((d) => dateSchema.safeParse(d).success)) return;
  const latest = dates.reduce((a, b) => (b > a ? b : a));
  const rows = dates.flatMap((d, i) => (d === latest ? ['第 ' + (i + 1) + ' 行'] : []));
  result.header.deliveryDate = {
    value: latest,
    certainty: 'needs-review',
    note: '原件没写整单交期，取明细里最晚的交期（' + rows.join('、') + '），请核对',
  };
}

/**
 * 客户订单识别：把原件交给模型出识别结果（analyze、enqueue）。识别后要改，用全局助手（它走 manager.edit）。
 * 同一工作区同时只跑一个模型调用（exclusive），失败记错误档案、任务状态写回工作区库。
 */
export class OrderRecognition {
  constructor(private store: WorkspaceStore) {}
  /** 没填密钥先说清；再读原件、核对哈希 */
  private async original(w: Workspace) {
    const ai = this.store.options.settings.status();
    if (!ai.ready) throw new AppError(ai.message, 400, 'key_required');
    const { bytes } = await this.store.original(w.id);
    return { name: w.fileName, data: bytes };
  }
  private async exclusive(id: string, job: () => Promise<WorkspaceView>, context: FailureContext) {
    const store = this.store;
    if (store.busy.has(id) || store.importing.has(id))
      throw new AppError('该工作区正在调用 AI，请勿重复提交。', 429, 'busy');
    const controller = new AbortController();
    store.busy.set(id, controller);
    store.repo.task(id, { state: 'queued', startedAt: new Date().toISOString() });
    try {
      const result = await job();
      if (controller.signal.aborted) throw new AppError('任务已取消。', 409, 'cancelled');
      store.repo.task(id, { state: 'ready' });
      result.task = { state: 'ready' };
      return result;
    } catch (e) {
      let failureId: string | undefined;
      if (!controller.signal.aborted) {
        try {
          failureId = store.recordFailure(e, store.repo.get(id) || { id }, context);
        } catch {
          // 错误档案写不进去：下面写任务状态时带上 diagnosticStorageError，页面会如实说“错误档案写入失败”
        }
      }
      if (store.repo.get(id))
        store.repo.task(id, {
          state: controller.signal.aborted ? 'cancelled' : 'failed',
          error:
            e instanceof AppError || e instanceof AiConnectionError
              ? e.message
              : '模型连续两次没有返回可用结果，原识别结果没有变化，可以再试一次。',
          failureId,
          ...(!controller.signal.aborted && !failureId
            ? { diagnosticStorageError: '错误档案写入失败，请检查磁盘空间和目录权限。' }
            : {}),
        });
      if (controller.signal.aborted) throw new AppError('任务已取消，未保存不完整结果。', 409, 'cancelled');
      throw e;
    } finally {
      store.busy.delete(id);
    }
  }
  /** 模型进度写进任务状态，同时转给调用方 */
  private progress(id: string, attempt: FailureContext, onProgress?: (event: AiProgress) => void) {
    return {
      onProgress: (p: AiProgress) => {
        attempt.stage = p.stage;
        this.store.repo.task(id, { state: 'running', progress: p });
        onProgress?.(p);
      },
      onQueue: (q: NonNullable<WorkspaceView['task']>) => this.store.repo.task(id, q),
    };
  }
  async analyze(
    id: string,
    raw: unknown,
    onProgress?: (event: AiProgress) => void,
    actor?: { id: string; name: string } | null,
    onUsage?: (usage: ProviderTokenUsage) => void,
  ) {
    const { expectedRevision, stream, force } = workspaceEnqueueSchema
      .extend({ force: z.boolean().default(false) })
      .parse(raw);
    const attempt: FailureContext = { operation: 'analyze', stream, stage: 'authorization', startedAt: Date.now(), actor };
    const store = this.store;
    return this.exclusive(
      id,
      async () => {
        const w = store.load(id);
        store.check(w, expectedRevision);
        if (w.mode !== 'order') throw new AppError('此文件不是客户订单识别模式。', 409);
        if (w.imported) throw new AppError('该文件已正式导入，不能重新识别覆盖；如需重新识别请另建工作区。', 409);
        if (w.draft && !force)
          throw new AppError('已有识别结果，请在表格里改或让助手改，避免重新识别覆盖已核对内容。', 409);
        const file = await this.original(w);
        attempt.stage = 'uploading-file';
        const prompt = store.promptPresets.snapshot(),
          signal = store.busy.get(id)?.signal;
        // 交回的表不合格重试一次，用的是同一份已上传的文件
        const result = await withSourceFile(
          store.options.settings,
          file,
          (source) =>
            retryBadModelOutput(async () => {
              attempt.stage = 'recognizing';
              const filled = await store.options.settings.fillForm(
                [{ role: 'system', content: analysisPrompt(prompt.preset) }, source],
                orderFormTool(),
                signal,
                { onUsage, ...this.progress(id, attempt, onProgress) },
              );
              attempt.stage = 'schema-validation';
              return usableAnalysis(filled);
            }, signal),
          signal,
        );
        for (const field of [...Object.values(result.header), ...result.lines.flatMap((l) => Object.values(l))]) {
          if (field.value !== null && field.certainty === 'needs-review')
            field.note = (field.note + '；请对照原文件人工核对').slice(0, DRAFT_NOTE_MAX);
        }
        deliveryFromLines(result);
        if (store.busy.get(id)?.signal.aborted) throw new AppError('任务已取消。', 409, 'cancelled');
        const latest = store.load(id);
        store.check(latest, expectedRevision);
        latest.draft = {
          header: result.header,
          lines: result.lines.map((fields) => ({ id: randomUUID(), fields })),
          warnings: result.warnings,
        };
        latest.mapping = undefined;
        latest.mappingInvalidated = undefined;
        latest.promptPreset = prompt.usage;
        store.save(latest, expectedRevision, 'ai-analyze');
        return store.view(latest);
      },
      attempt,
    );
  }
  /** 后台开始识别，马上返回当前工作区 */
  enqueue(id: string, raw: unknown, actor?: { id: string; name: string } | null) {
    const store = this.store;
    if (store.busy.has(id)) return store.get(id);
    const input = workspaceEnqueueSchema.parse(raw),
      w = store.load(id);
    store.check(w, input.expectedRevision);
    if (w.draft) return store.get(id);
    void this.analyze(id, input, undefined, actor).catch(() => {});
    return store.get(id);
  }

}
