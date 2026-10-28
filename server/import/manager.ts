import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, rm, rename, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { z } from 'zod';
import {
  analysisSchema,
  chatReplySchema,
  patchOperationSchema,
  headerFields,
  lineFields,
  fieldLabels,
  evaluateDraft,
  verifiedCalculationNote,
  type OrderDraft,
  type ImportWorkspaceView,
  type DraftOperation,
  type DraftChange,
} from '../../shared/order-draft.js';
import { dateSchema } from '../../shared/domain.js';
import { AiSettingsManager } from '../ai/settings-manager.js';
import type { ChatMessage } from '../ai/compatible-chat.js';
import type { ProviderTokenUsage } from '../ai/usage.js';
import { getBusinessMetadata } from '../business/metadata.js';
import { storeOriginal, detectFormat } from './file-store.js';
import type { parseUpload } from './parse-file.js';
import type { AiProgress } from '../../shared/ai-runtime.js';
import { ImportRepository } from './repository.js';
import { ImportError } from './errors.js';
import type { Actor } from '../auth.js';
import {
  requireDeveloper,
  requireLocalAdministrator,
  isLocalAdministrator,
} from '../developer-capability.js';

type View = ImportWorkspaceView;
type Workspace = View & {
  archived?: boolean;
  arrivalAssistant?: any;
  history: { draft: OrderDraft; changes: DraftChange[] }[];
  consentProfile: {
    id: string;
    endpoint: string;
    model: string;
    apiStyle?: 'chat-completions' | 'responses';
  } | null;
  audits: { at: string; kind: string; revision: number; changes: DraftChange[] }[];
};
const revisionSchema = z.strictObject({ expectedRevision: z.number().int().nonnegative() });
import { analysisPrompt, chatPrompt, PROMPT_VERSION } from './prompts.js';
import { blankField } from '../../shared/order-draft.js';
import { mappingSchema } from '../../shared/import-mapping.js';
import { AiConnectionError } from '../ai/connection-error.js';
import { existsSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { orderSourceMessage, recognitionMode, recognitionScope } from './source-message.js';
import { failureRecord, type FailureContext } from './failure-record.js';
import { officialDeepSeekEndpoint } from '../../shared/assistant-attachments.js';
import { PromptPresetManager } from '../ai/prompt-presets.js';
import {
  normalizeDimensionUnit,
  parseDimension,
  convertDimension,
  dimensionKeys,
} from '../../shared/product-details.js';
export class ImportManager {
  abortArrival?: (sourceId: string) => void;
  arrivalDocumentExists?: (id: number) => boolean;
  private importing = new Set<string>();
  readonly promptPresets: PromptPresetManager;
  private repo: ImportRepository;
  private busy = new Map<string, AbortController>();
  private deleting = new Set<string>();
  private uploading = false;
  constructor(
    private options: {
      directory: string;
      settings: AiSettingsManager;
      database?: string;
      parser?: typeof parseUpload;
      promptPresets?: PromptPresetManager;
      findImport?: (id: string, hash?: string) => ImportWorkspaceView['imported'];
      validateMapping?: (mapping: import('../../shared/import-mapping.js').ImportMapping) => void;
    },
  ) {
    options.directory = resolve(options.directory);
    this.promptPresets = options.promptPresets || new PromptPresetManager();
    this.repo = new ImportRepository(
      options.database || join(options.directory, 'workspaces.sqlite'),
    );
    // 重启修复文件移动与数据库提交之间的中间态，不保留悬空文件引用。
    for (const w of this.repo.list()) {
      const current = join(options.directory, w.id),
        trash = join(options.directory, '_trash', w.id);
      if (!existsSync(current) && existsSync(trash)) renameSync(trash, current);
    }
    for (const w of this.repo.trash() as { id: string }[]) {
      const current = join(options.directory, w.id),
        trash = join(options.directory, '_trash', w.id);
      if (existsSync(current) && !existsSync(trash)) renameSync(current, trash);
    }
    const staging = resolve(options.directory, '_deleting');
    if (existsSync(staging))
      for (const id of readdirSync(staging)) {
        if (!z.string().uuid().safeParse(id).success) continue;
        const target = resolve(staging, id);
        if (dirname(target) !== staging) continue;
        const active = this.repo.get(id),
          legacy = this.repo.trash().some((r) => r.id === id);
        if (active || legacy)
          renameSync(target, resolve(options.directory, ...(legacy ? ['_trash', id] : [id])));
        else rmSync(target, { recursive: true, force: true });
      }
  }
  close() {
    for (const controller of this.busy.values()) controller.abort();
    this.repo.close();
    if (!this.options.promptPresets) this.promptPresets.close();
  }
  isBusy(id: string) {
    return this.busy.has(id);
  }
  mapping(id: string, raw: unknown, who?: Actor | null) {
    const v = revisionSchema.extend({ mapping: mappingSchema }).parse(raw),
      w = this.load(id);
    this.check(w, v.expectedRevision, isLocalAdministrator(who));
    if (!w.draft) throw new ImportError('请先识别订单。');
    if (Object.keys(v.mapping.products).some((id) => !w.draft!.lines.some((l) => l.id === id)))
      throw new ImportError('匹配对象不属于当前订单。');
    if (this.options.validateMapping) this.options.validateMapping(v.mapping);
    else if (
      v.mapping.customer.mode === 'existing' ||
      Object.values(v.mapping.products).some((p) => p.mode === 'existing')
    )
      throw new ImportError('当前服务未连接档案校验器，不能保存未经验证的关联。');
    w.mapping = v.mapping;
    w.confirmedRevision = null;
    this.save(w, v.expectedRevision, 'mapping');
    return this.view(w);
  }
  get csrfToken() {
    return this.options.settings.csrfToken;
  }
  trash() {
    return this.repo.trash();
  }
  archives() {
    return [...this.repo.archived(), ...this.repo.trash()];
  }
  archiveWorkspace(id: string, revision: number, who: Actor) {
    requireLocalAdministrator(who);
    const w = this.load(id);
    this.check(w, revision, true);
    if (this.isBusy(id) || this.importing.has(id))
      throw new ImportError('任务正在处理，结束后可归档；删除可取消识别任务。', 409);
    w.archived = true;
    this.save(w, revision, 'archive');
    return this.get(id);
  }
  async restoreWorkspace(id: string, who: Actor) {
    requireLocalAdministrator(who);
    if (!this.repo.get(id)) return this.restore(id);
    const w = this.load(id);
    w.archived = false;
    this.save(w, w.revision, 'restore-archive');
    return this.get(id);
  }
  async openArchivedWorkspace(id: string, who: Actor) {
    requireLocalAdministrator(who);
    // 旧回收格式转换为可编辑归档，始终保留归档状态，不要求先恢复为正常记录。
    if (!this.repo.get(id)) await this.restore(id, true);
    return this.get(id);
  }
  async deleteWorkspace(id: string, revision: number | undefined, who: Actor) {
    requireLocalAdministrator(who);
    z.string().uuid().parse(id);
    const w = this.repo.get(id);
    if (w && revision !== undefined && w.revision !== revision)
      throw new ImportError('工作区版本已变化，请刷新。', 409);
    if (this.importing.has(id))
      throw new ImportError('工作区正在提交数据库事务，请完成后重试删除。', 409);
    this.busy.get(id)?.abort();
    if (w?.arrivalSourceId) this.abortArrival?.(w.arrivalSourceId);
    this.deleting.add(id);
    const base = resolve(this.options.directory),
      active = resolve(base, id),
      archived = resolve(base, '_trash', id),
      stage = resolve(base, '_deleting', id);
    if (
      dirname(active) !== base ||
      dirname(archived) !== resolve(base, '_trash') ||
      dirname(stage) !== resolve(base, '_deleting')
    )
      throw new ImportError('工作区路径异常。');
    const source = existsSync(active) ? active : existsSync(archived) ? archived : null;
    try {
      await mkdir(resolve(base, '_deleting'), { recursive: true });
      if (source) await rename(source, stage);
      try {
        this.repo.physicalDelete(id);
      } catch (e) {
        if (source) await rename(stage, source);
        throw e;
      }
      await rm(stage, { recursive: true, force: true });
      return { id, deleted: true, recoverable: false };
    } finally {
      this.deleting.delete(id);
    }
  }
  private tags(w: { id: string; fileHash: string }) {
    const ref = this.options.findImport?.(w.id, w.fileHash);
    const own = ref && !ref.historical ? ref : undefined;
    return { imported: own, historyImport: own ? undefined : ref };
  }
  status() {
    // 工作区与业务库独立保存；读取前解除已物理删除的单据引用，保留独立识别草稿。
    for (const row of this.repo.list()) this.load(row.id);
    const p = this.options.settings.view().active;
    return {
      csrfToken: this.csrfToken,
      active: p,
      workspaces: this.repo.list().map((w: any) => ({ ...w, ...this.tags(w) })),
      writesEnabled: !!this.options.findImport,
      trash: this.repo.trash(),
      archives: this.archives(),
      promptVersion: PROMPT_VERSION,
      limits: { maxFileMB: 10 },
      queue: this.options.settings.workQueue.stats(),
      scope: recognitionScope(p?.endpoint),
      inputMode: recognitionMode(p?.endpoint),
    };
  }
  private load(id: string): Workspace {
    z.string().uuid().parse(id);
    const w = this.repo.get(id) as Workspace | null;
    if (!w) throw new ImportError('导入工作区不存在。', 404);
    if (
      w.arrivalDocId &&
      this.arrivalDocumentExists &&
      !this.arrivalDocumentExists(w.arrivalDocId)
    ) {
      w.arrivalDocId = null;
      this.save(w, w.revision, 'detach-deleted-arrival');
    }
    if (w.draft)
      for (const l of w.draft.lines) for (const key of lineFields) l.fields[key] ||= blankField();
    if (
      w.consent?.policyVersion !==
      (recognitionMode(w.consentProfile?.endpoint) === 'deepseek-compatible' ? 4 : 3)
    ) {
      w.consent = null;
      w.consentProfile = null;
    }
    return w;
  }
  private view(w: Workspace): View {
    if (w.draft)
      for (const l of w.draft.lines) for (const key of lineFields) l.fields[key] ||= blankField();
    const { history, consentProfile, audits, arrivalAssistant, ...view } = w;
    const tags = this.tags(w);
    return {
      ...view,
      imported: tags.imported ?? view.imported,
      historyImport: tags.historyImport,
      parsed: { ...view.parsed, blocks: [], previews: [], imagePages: [], warnings: [] },
      evaluation: w.draft ? evaluateDraft(w.draft) : null,
      canUndo: history.length > 0,
    };
  }
  get(id: string) {
    return this.view(this.load(id));
  }
  arrivalAssistant(id: string) {
    return structuredClone(this.load(id).arrivalAssistant || null);
  }
  saveArrivalAssistant(id: string, expectedRevision: number, state: unknown) {
    const w = this.load(id);
    this.check(w, expectedRevision);
    if (w.mode !== 'arrival') throw new ImportError('此文件不是到货单识别模式。', 409);
    w.arrivalAssistant = state;
    this.save(w, expectedRevision, 'arrival-draft-assistant');
    return this.get(id);
  }
  setMode(id: string, raw: unknown) {
    const input = revisionSchema.extend({ mode: z.enum(['order', 'arrival']) }).parse(raw),
      w = this.load(id);
    this.check(w, input.expectedRevision);
    if (w.mode === input.mode) return this.view(w);
    w.mode = input.mode;
    this.save(w, input.expectedRevision, 'mode');
    return this.view(w);
  }
  linkArrival(id: string, raw: unknown) {
    const input = revisionSchema
        .extend({
          docId: z.number().int().positive().nullable(),
          sourceId: z.string().uuid().nullable().optional(),
        })
        .parse(raw),
      w = this.load(id);
    this.check(w, input.expectedRevision);
    w.arrivalDocId = input.docId;
    if (input.sourceId !== undefined) w.arrivalSourceId = input.sourceId;
    this.save(w, input.expectedRevision, 'arrival-draft-link');
    return this.view(w);
  }
  async original(id: string) {
    const w = this.load(id);
    const bytes = await readFile(join(this.options.directory, w.id, 'original'));
    if (createHash('sha256').update(bytes).digest('hex') !== w.fileHash)
      throw new ImportError('原件完整性校验失败。', 409, 'source');
    return { bytes, fileName: w.fileName };
  }
  private check(w: Workspace, revision: number, allowImported = false) {
    if (this.importing.has(w.id))
      throw new ImportError('正在提交正式导入，请等待完成。', 409, 'busy');
    const imported = this.options.findImport?.(w.id, w.fileHash);
    if (!allowImported && imported && !imported.historical)
      throw new ImportError(
        '该工作区已导入正式订单，不能继续修改；如需再次导入同一原件，请重新上传建立新的导入任务。',
        409,
        'imported',
      );
    if (w.revision !== revision)
      throw new ImportError('草稿已变化，请刷新后核对最新版本。', 409, 'stale');
  }
  private save(w: Workspace, expected: number, kind: string, changes: DraftChange[] = []) {
    if (this.deleting.has(w.id) || !this.repo.get(w.id))
      throw new ImportError('任务已取消或文件已删除。', 409, 'cancelled');
    w.revision = expected + 1;
    w.audits.push({ at: new Date().toISOString(), kind, revision: w.revision, changes });
    if (w.audits.length > 300) throw new ImportError('本工作区操作记录超过 300 次，请另建工作区。');
    if (Buffer.byteLength(JSON.stringify(w)) > 20 * 1024 * 1024)
      throw new ImportError('工作区历史超过 20 MB，请另建工作区。');
    try {
      this.repo.save(w, expected);
    } catch {
      throw new ImportError('草稿保存冲突或磁盘不可写，请刷新后重试。', 409, 'storage');
    }
  }
  async upload(buffer: Buffer, fileName: string, isolate = false) {
    if (this.uploading) throw new ImportError('正在保存其他原文件，请稍候。', 429, 'busy');
    detectFormat(buffer, fileName);
    const hash = createHash('sha256').update(buffer).digest('hex'),
      // 相同原件只有在“尚未导入且没有草稿”时才复用原任务，避免重复占用原件；
      // 已识别或已导入的相同文件重新上传时建立独立导入任务，不能阻止再次识别。
      sibling =
        !isolate &&
        this.repo.byHashAll(hash).find((w) => {
          const ref = this.options.findImport?.(w.id, w.fileHash);
          return !(ref && !ref.historical) && !w.draft;
        });
    if (sibling) return { workspace: this.view(sibling), duplicate: true };
    const stats = this.repo.stats();
    if (stats.count >= 200 || stats.bytes + buffer.length > 500 * 1024 * 1024)
      throw new ImportError(
        '本机导入工作区已达到 200 份文件或 500 MB 原件上限，请先备份并安排数据保留清理。',
        413,
        'storage',
      );
    this.uploading = true;
    const id = randomUUID(),
      directory = join(this.options.directory, id);
    try {
      const parsed = await storeOriginal(buffer, fileName, id, directory);
      const w: Workspace = {
        id,
        revision: 0,
        fileName: fileName.replace(/[\r\n\x00-\x1f]/g, '').slice(0, 180),
        fileHash: hash,
        size: buffer.length,
        createdAt: new Date().toISOString(),
        parsed,
        draft: null,
        evaluation: null,
        confirmedRevision: null,
        messages: [],
        changes: [],
        canUndo: false,
        consent: null,
        consentProfile: null,
        history: [],
        audits: [],
        task: { state: 'uploaded' },
        promptVersion: PROMPT_VERSION,
        inputMode: 'raw-file',
        mode: 'order',
        arrivalDocId: null,
        arrivalSourceId: null,
      };
      this.repo.insert(w);
      return { workspace: this.view(w), duplicate: false };
    } catch (error) {
      if (dirname(resolve(directory)) !== this.options.directory)
        throw new ImportError('工作区路径校验失败。');
      await rm(directory, { recursive: true, force: true });
      throw error;
    } finally {
      this.uploading = false;
    }
  }
  cancel(id: string, raw: unknown) {
    const { expectedRevision } = revisionSchema.parse(raw),
      w = this.load(id);
    this.check(w, expectedRevision);
    this.busy.get(id)?.abort();
    if (w.arrivalSourceId) this.abortArrival?.(w.arrivalSourceId);
    this.repo.task(id, { state: 'cancelled' });
    w.task = { state: 'cancelled' };
    this.save(w, expectedRevision, 'cancel-task');
    return this.get(id);
  }
  async developerFork(id: string, who: Actor) {
    requireDeveloper(who);
    const old = this.load(id),
      original = await this.original(id);
    if (this.isBusy(id) || this.importing.has(id))
      throw new ImportError('请先等待或取消正在执行的任务。', 409);
    const created = await this.upload(original.bytes, original.fileName, true),
      next = this.load(created.workspace.id);
    next.draft = structuredClone(old.draft);
    next.mode = old.mode;
    next.mapping = structuredClone(old.mapping);
    next.arrivalSourceId = old.arrivalSourceId;
    next.arrivalDocId = null;
    next.task = { state: next.draft ? 'ready' : 'uploaded' };
    this.save(next, next.revision, 'developer-fork');
    return this.get(next.id);
  }
  async developerPurge(id: string, who: Actor) {
    requireDeveloper(who);
    z.string().uuid().parse(id);
    if (!this.repo.trash().some((r) => r.id === id))
      throw new ImportError('请先将选定文件移入工作区回收站。', 409);
    const target = resolve(this.options.directory, '_trash', id);
    if (dirname(target) !== resolve(this.options.directory, '_trash'))
      throw new ImportError('工作区路径异常。');
    await rm(target, { recursive: true, force: true });
    this.repo.forgetTrash(id);
    return { id, permanentlyDeleted: true };
  }
  async remove(id: string, raw: unknown) {
    const { expectedRevision } = revisionSchema
      .extend({ acknowledged: z.literal(true) })
      .parse(raw);
    const w = this.load(id);
    if (this.importing.has(id)) throw new ImportError('正在提交正式导入，请稍后删除工作区。', 409);
    if (w.revision !== expectedRevision) throw new ImportError('工作区已变化，请刷新后重试。', 409);
    this.deleting.add(id);
    this.busy.get(id)?.abort();
    if (w.arrivalSourceId) this.abortArrival?.(w.arrivalSourceId);
    const from = join(this.options.directory, id),
      to = join(this.options.directory, '_trash', id);
    await mkdir(join(this.options.directory, '_trash'), { recursive: true });
    try {
      await rename(from, to);
      this.repo.remove(id);
    } catch (e) {
      await rename(to, from).catch(() => {});
      throw new ImportError('删除失败，文件仍保留，请刷新后重试。', 409);
    } finally {
      this.deleting.delete(id);
    }
    return { removed: true, recoverable: true };
  }
  async removeMany(raw: unknown) {
    const { items } = z
      .strictObject({
        acknowledged: z.literal(true),
        items: z
          .array(
            z.strictObject({
              id: z.string().uuid(),
              expectedRevision: z.number().int().nonnegative(),
            }),
          )
          .min(1)
          .max(200),
      })
      .parse(raw);
    if (new Set(items.map((i) => i.id)).size !== items.length)
      throw new ImportError('不能重复选择同一文件。');
    const results = [];
    for (const item of items) {
      try {
        await this.remove(item.id, { expectedRevision: item.expectedRevision, acknowledged: true });
        results.push({ id: item.id, removed: true, message: '已移入回收站' });
      } catch (error) {
        results.push({
          id: item.id,
          removed: false,
          message:
            error instanceof ImportError ? error.message : '删除失败，原文件保留，请刷新后重试。',
        });
      }
    }
    return { results };
  }
  async restore(id: string, keepArchived = false) {
    z.string().uuid().parse(id);
    const from = join(this.options.directory, '_trash', id),
      to = join(this.options.directory, id);
    await rename(from, to);
    try {
      this.repo.restore(id, keepArchived);
      const restored = this.load(id);
      restored.task = { state: restored.draft ? 'ready' : 'uploaded' };
      this.repo.task(id, restored.task);
      return this.view(restored);
    } catch {
      await rename(to, from);
      throw new ImportError('恢复失败：该任务已存在或原件目录被占用，请刷新后重试。', 409);
    }
  }
  async file(id: string, page?: number) {
    const w = this.load(id);
    if (page !== undefined) throw new ImportError('本地解析预览已停用，请下载原文件核对。', 404);
    return {
      bytes: await readFile(join(this.options.directory, id, 'original')),
      name: w.fileName,
      mime:
        w.parsed.format === 'jpg'
          ? 'image/jpeg'
          : w.parsed.format === 'png'
            ? 'image/png'
            : 'application/octet-stream',
    };
  }
  consent(id: string, raw: unknown) {
    const input = revisionSchema
        .extend({
          accepted: z.literal(true),
          presetId: z.string().uuid(),
          endpoint: z.string().max(500),
          model: z.string().max(160),
          apiStyle: z.enum(['chat-completions', 'responses']).default('chat-completions'),
        })
        .parse(raw),
      w = this.load(id);
    this.check(w, input.expectedRevision);
    const p = this.options.settings.view().active;
    if (!p?.hasApiKey || !p.model)
      throw new ImportError('请先在 AI 设置中保存并启用预设。', 400, 'settings');
    if (
      p.id !== input.presetId ||
      p.endpoint !== input.endpoint ||
      p.model !== input.model ||
      (p.apiStyle || 'chat-completions') !== input.apiStyle
    )
      throw new ImportError(
        'AI目标或协议已变化，请刷新页面并重新确认地址、模型和协议。',
        409,
        'consent',
      );
    w.consent = {
      id: randomBytes(24).toString('hex'),
      endpoint: p.endpoint,
      model: p.model,
      expiresAt: new Date(Date.now() + 24 * 3600000).toISOString(),
      scope: this.status().scope,
      policyVersion: recognitionMode(p.endpoint) === 'deepseek-compatible' ? 4 : 3,
      apiStyle: input.apiStyle,
    };
    w.consentProfile = { id: p.id, endpoint: p.endpoint, model: p.model, apiStyle: input.apiStyle };
    this.save(w, input.expectedRevision, 'consent');
    return this.view(w);
  }
  revoke(id: string, raw: unknown) {
    const { expectedRevision } = revisionSchema.parse(raw),
      w = this.load(id);
    this.check(w, expectedRevision, true);
    w.consent = null;
    w.consentProfile = null;
    this.save(w, expectedRevision, 'revoke-consent');
    return this.view(w);
  }
  private async external(w: Workspace) {
    const p = this.options.settings.view().active;
    if (!w.consent || !w.consentProfile || Date.parse(w.consent.expiresAt) < Date.now())
      throw new ImportError('请先确认本文件和草稿的外发范围。', 403, 'consent');
    if (
      !p ||
      p.id !== w.consentProfile.id ||
      p.endpoint !== w.consentProfile.endpoint ||
      p.model !== w.consentProfile.model ||
      (p.apiStyle || 'chat-completions') !== (w.consentProfile.apiStyle || 'chat-completions')
    )
      throw new ImportError('当前AI服务、模型或协议已切换，请重新确认外发范围。', 409, 'consent');
    const original = await readFile(join(this.options.directory, w.id, 'original'));
    if (createHash('sha256').update(original).digest('hex') !== w.fileHash)
      throw new ImportError('原件完整性校验失败，已停止外发。', 409, 'source');
    return w.consentProfile;
  }
  private async sourceMessage(w: Workspace): Promise<ChatMessage> {
    const data = await readFile(join(this.options.directory, w.id, 'original'));
    return orderSourceMessage(
      w.fileName,
      data,
      w.consentProfile!.endpoint,
      w.consentProfile?.apiStyle,
    );
  }
  abortRequest(id: string) {
    this.busy.get(id)?.abort();
  }
  async withImportSource<T>(
    id: string,
    revision: number,
    job: (w: ImportWorkspaceView, bytes: Buffer) => Promise<T>,
  ): Promise<T> {
    const w = this.get(id);
    if (this.busy.has(id) || this.importing.has(id))
      throw new ImportError('工作区任务尚未结束，请稍后操作。', 409);
    if (w.revision !== revision) throw new ImportError('草稿已变化，请重新生成导入预览。', 409);
    this.importing.add(id);
    try {
      const bytes = await readFile(join(this.options.directory, id, 'original'));
      if (createHash('sha256').update(bytes).digest('hex') !== w.fileHash)
        throw new ImportError('来源文件完整性校验失败。', 409);
      return await job(w, bytes);
    } finally {
      this.importing.delete(id);
    }
  }
  failures(workspaceId?: string, offset = 0) {
    return this.repo.failures(workspaceId, offset);
  }
  failure(id: string) {
    const r = this.repo.failure(z.string().uuid().parse(id));
    if (!r) throw new ImportError('错误记录不存在。', 404);
    return r;
  }
  recordFailure(error: unknown, w: any, context: FailureContext) {
    const record = failureRecord(error, w, context, this.options.settings.view().active);
    this.repo.addFailure(record);
    return record.id;
  }
  private async exclusive<T>(id: string, job: () => Promise<T>, context: FailureContext) {
    if (this.busy.has(id) || this.importing.has(id))
      throw new ImportError('该工作区正在调用 AI，请勿重复提交。', 429, 'busy');
    const controller = new AbortController();
    this.busy.set(id, controller);
    this.repo.task(id, { state: 'queued', startedAt: new Date().toISOString() });
    try {
      const result = await job();
      if (controller.signal.aborted) throw new ImportError('任务已取消。', 409, 'cancelled');
      this.repo.task(id, { state: 'ready' });
      if (result && typeof result === 'object') (result as any).task = { state: 'ready' };
      return result;
    } catch (e) {
      let failureId: string | undefined;
      if (!controller.signal.aborted) {
        try {
          failureId = this.recordFailure(e, this.repo.get(id) || { id }, context);
        } catch {
          /* task message below explicitly reports storage failure */
        }
      }
      if (this.repo.get(id))
        this.repo.task(id, {
          state: controller.signal.aborted ? 'cancelled' : 'failed',
          error:
            e instanceof ImportError || e instanceof AiConnectionError
              ? e.message
              : 'AI响应结构或处理结果不符合约定，未修改草稿。请重试或检查模型。',
          failureId,
          ...(!controller.signal.aborted && !failureId
            ? { diagnosticStorageError: '错误档案写入失败，请检查磁盘空间和目录权限。' }
            : {}),
        });
      if (controller.signal.aborted)
        throw new ImportError('任务已取消，未保存不完整结果。', 409, 'cancelled');
      throw e;
    } finally {
      this.busy.delete(id);
    }
  }
  async analyze(
    id: string,
    raw: unknown,
    onProgress?: (event: AiProgress) => void,
    actor?: { id: string; name: string } | null,
    onUsage?: (usage: ProviderTokenUsage) => void,
  ) {
    const { expectedRevision, stream, force } = revisionSchema
      .extend({ stream: z.boolean().default(true), force: z.boolean().default(false) })
      .parse(raw);
    const attempt: FailureContext = {
      operation: 'analyze',
      stream,
      stage: 'authorization',
      startedAt: Date.now(),
      actor,
    };
    return this.exclusive(
      id,
      async () => {
        const w = this.load(id);
        this.check(w, expectedRevision);
        if (w.imported)
          throw new ImportError(
            '该文件已正式导入，不能重新识别覆盖；如需重新识别请另建工作区。',
            409,
          );
        if (w.draft && !force)
          throw new ImportError(
            '已有草稿，请通过聊天或表格修改，避免重新识别覆盖已核对内容。',
            409,
          );
        const profile = await this.external(w);
        attempt.stage = 'preparing-file';
        const prompt = this.promptPresets.snapshot();
        const response = await this.options.settings.completeOrderJson(
          [
            {
              role: 'system',
              content: analysisPrompt(prompt.preset),
            },
            await this.sourceMessage(w),
          ],
          profile,
          this.busy.get(id)?.signal,
          {
            stream: profile.apiStyle === 'responses' && stream,
            onUsage,
            ...(officialDeepSeekEndpoint(profile.endpoint)
              ? { maxOutputTokens: 16000, disableThinking: true }
              : {}),
            onProgress: (p) => {
              attempt.stage = p.stage;
              this.repo.task(id, { state: 'running', progress: p });
              onProgress?.(p);
            },
            onQueue: (q) => this.repo.task(id, q),
          },
        );
        attempt.stage = 'schema-validation';
        const result = analysisSchema.parse(response);
        if (!result.lines.some((l) => l.productName.value || l.quantity.value || l.unitPrice.value))
          throw new ImportError(
            '没有识别到可用订单明细，请核对原文件、模型和文件输入能力。',
            422,
            'model-schema',
          );
        for (const field of [
          ...Object.values(result.header),
          ...result.lines.flatMap((l) => Object.values(l)),
        ]) {
          if (field.certainty === 'user-modified')
            throw new ImportError('AI不得伪造人工修改状态。', 422, 'model-schema');
          // 原件级来源由后端UUID/哈希绑定；不依赖OCR文本或模型编造的本地来源编号。
          field.sources = [];
          if (field.value !== null) {
            field.certainty = 'needs-review';
            field.note = (field.note + '；请对照原文件人工核对').slice(0, 600);
          }
        }
        if (this.busy.get(id)?.signal.aborted)
          throw new ImportError('任务已取消。', 409, 'cancelled');
        const latest = this.load(id);
        this.check(latest, expectedRevision);
        latest.draft = {
          header: result.header,
          lines: result.lines.map((fields) => ({ id: randomUUID(), fields })),
          warnings: result.warnings,
        };
        latest.confirmedRevision = null;
        latest.promptPreset = prompt.usage;
        latest.inputMode = recognitionMode(profile.endpoint);
        latest.messages.push({
          role: 'assistant',
          text:
            (force ? '已重新识别并覆盖原草稿' : '已完成真实 AI 识别') +
            '（提示词：' +
            prompt.usage.name +
            '）。金额由后端重算，请核对来源与待确认项。',
          at: new Date().toISOString(),
        });
        this.save(latest, expectedRevision, 'ai-analyze');
        return this.view(latest);
      },
      attempt,
    );
  }
  enqueue(id: string, raw: unknown, actor?: { id: string; name: string } | null) {
    if (this.busy.has(id)) return this.get(id);
    const input = revisionSchema.extend({ stream: z.boolean().default(true) }).parse(raw),
      w = this.load(id);
    this.check(w, input.expectedRevision);
    if (w.draft) return this.get(id);
    void this.analyze(id, input, undefined, actor).catch(() => {});
    return this.get(id);
  }
  private apply(w: Workspace, operations: DraftOperation[], origin: 'manual' | 'ai') {
    if (!w.draft) throw new ImportError('请先识别生成草稿。');
    if (w.history.length >= 80) throw new ImportError('可撤销修改次数超过 80 次，请另建工作区。');
    const before = structuredClone(w.draft),
      changes: DraftChange[] = [];
    const priorAmountValid = !evaluateDraft(before).issues.some(
      (i) =>
        i.severity === 'error' && /statedAmount|statedTotalQuantity|statedTotalAmount/.test(i.path),
    );
    const expanded = [...operations];
    for (const op of operations) {
      if (op.op !== 'set-line' || op.field !== 'dimensionUnit') continue;
      const line = w.draft.lines.find((l) => l.id === op.lineId);
      if (!line) continue;
      const from = normalizeDimensionUnit(line.fields.dimensionUnit.value),
        to = normalizeDimensionUnit(op.value);
      if (from && to && from !== to) {
        for (const axis of dimensionKeys) {
          if (
            operations.some(
              (o) => o.op === 'set-line' && o.lineId === op.lineId && o.field === axis,
            )
          )
            continue;
          try {
            const number = convertDimension(parseDimension(line.fields[axis].value), from, to);
            if (number !== null)
              expanded.unshift({
                op: 'set-line',
                lineId: op.lineId,
                field: axis,
                value: String(number),
                reason: '尺寸单位换算：1cm=10mm',
              });
          } catch {
            throw new ImportError('尺寸不是有效正数，请先修正或清空后再切换单位。');
          }
        }
      }
    }
    for (const op of expanded) {
      let field;
      if (op.op === 'set-header') field = w.draft.header[op.field];
      else {
        const line = w.draft.lines.find((l) => l.id === op.lineId);
        if (!line) throw new ImportError('修改指向不存在的订单明细。', 422, 'model-schema');
        field = line.fields[op.field];
      }
      const value = op.value === null ? null : op.value.trim() || null;
      if (
        value !== null &&
        [
          'quantity',
          'unitPrice',
          'statedAmount',
          'taxRate',
          'statedTotalQuantity',
          'statedTotalAmount',
        ].includes(op.field)
      ) {
        if (
          !/^(?:0|[1-9]\d{0,14})(?:\.\d{1,12})?$/.test(value) ||
          (op.field === 'quantity' && Number(value) <= 0)
        )
          throw new ImportError('数量、单价、金额和税率必须是明确的非负十进制数；数量须大于零。');
      }
      if (
        value !== null &&
        ['orderDate', 'deliveryDate'].includes(op.field) &&
        !dateSchema.safeParse(value).success
      )
        throw new ImportError('修改日期必须填写有效 YYYY-MM-DD；年份不明时应先提问。');
      if (value === field.value) continue;
      changes.push({
        path: op.op === 'set-header' ? 'header.' + op.field : 'lines.' + op.lineId + '.' + op.field,
        label: fieldLabels[op.field],
        before: field.value,
        after: value,
        reason: op.reason,
      });
      field.value = value;
      field.certainty = 'user-modified';
      field.note = (
        (priorAmountValid && ['quantity', 'unitPrice'].includes(op.field)
          ? verifiedCalculationNote
          : '') +
        (origin === 'ai' ? '根据本次用户聊天修改：' : '人工修改：') +
        op.reason
      ).slice(0, 600);
    }
    if (changes.length) {
      w.history.push({ draft: before, changes });
      w.confirmedRevision = null;
      w.changes = changes;
      // 识别字段变化后，已有档案选择需重新核对，不能沿用旧的隐含确认。
      if (
        origin === 'manual' ||
        operations.some((op) =>
          [
            'buyerName',
            'productName',
            'productCode',
            'specification',
            'length',
            'width',
            'height',
            'dimensionUnit',
            'material',
            'flute',
            'unit',
          ].includes(op.field),
        )
      )
        w.mapping = undefined;
    } else w.changes = [];
    return changes;
  }
  edit(id: string, raw: unknown, origin: 'manual' | 'ai' = 'manual', who?: Actor | null) {
    const input = revisionSchema
        .extend({ operations: z.array(patchOperationSchema).min(1).max(100) })
        .parse(raw),
      w = this.load(id);
    this.check(w, input.expectedRevision, isLocalAdministrator(who));
    const changes = this.apply(w, input.operations, origin);
    this.save(
      w,
      input.expectedRevision,
      origin === 'ai' ? 'assistant-edit' : 'manual-edit',
      changes,
    );
    return this.view(w);
  }
  async chat(
    id: string,
    raw: unknown,
    onProgress?: (event: AiProgress) => void,
    actor?: { id: string; name: string } | null,
  ) {
    const input = revisionSchema
      .extend({ message: z.string().trim().min(1).max(2000), stream: z.boolean().default(true) })
      .parse(raw);
    const attempt: FailureContext = {
      operation: 'chat',
      stream: input.stream,
      stage: 'authorization',
      startedAt: Date.now(),
      actor,
    };
    return this.exclusive(
      id,
      async () => {
        const w = this.load(id);
        this.check(w, input.expectedRevision, isLocalAdministrator(actor as Actor));
        if (!w.draft) throw new ImportError('请先识别生成草稿。');
        if (w.messages.length >= 60)
          throw new ImportError('本工作区聊天已达 60 条，请保存核对记录后另建工作区。');
        const profile = await this.external(w);
        const prompt = this.promptPresets.snapshot();
        const messages: ChatMessage[] = [
          {
            role: 'system',
            content: chatPrompt(prompt.preset),
          },
          await this.sourceMessage(w),
          ...w.messages.slice(-12).map((m) => ({
            role: m.role,
            content:
              m.role === 'assistant'
                ? JSON.stringify({ reply: m.text, operations: [], questions: [] })
                : m.text,
          })),
          {
            role: 'user',
            content:
              '以下是唯一最新的当前草稿与后端计算。上面的聊天旧值可能已被撤销或人工改动，必须以此状态为准：' +
              JSON.stringify({ draft: w.draft, evaluation: evaluateDraft(w.draft) }),
          },
          {
            role: 'user',
            content:
              input.message +
              '\n请严格按回复Schema输出一个JSON对象，即使只是回答问题也必须使用 {"reply":"回答","operations":[],"questions":[]}；不要输出普通聊天文本。',
          },
        ];
        const result = chatReplySchema.parse(
          await this.options.settings.completeOrderJson(
            messages,
            profile,
            this.busy.get(id)?.signal,
            {
              stream: profile.apiStyle === 'responses' && input.stream,
              ...(officialDeepSeekEndpoint(profile.endpoint)
                ? { maxOutputTokens: 16000, disableThinking: true }
                : {}),
              onProgress: (p) => {
                attempt.stage = p.stage;
                this.repo.task(id, { state: 'running', progress: p });
                onProgress?.(p);
              },
              onQueue: (q) => this.repo.task(id, q),
            },
          ),
        );
        if (result.questions.length && result.operations.length)
          throw new ImportError(
            '模型一边提出未决问题一边修改草稿，已拒绝本次修改。',
            422,
            'model-schema',
          );
        if (this.busy.get(id)?.signal.aborted)
          throw new ImportError('任务已取消。', 409, 'cancelled');
        const latest = this.load(id);
        this.check(latest, input.expectedRevision, isLocalAdministrator(actor as Actor));
        const changes = this.apply(latest, result.operations, 'ai');
        latest.promptPreset = prompt.usage;
        const computed = evaluateDraft(latest.draft!);
        const calculation =
          changes.length || /金额|合计|总额|数量/.test(input.message)
            ? `\n\n后端已重算：总数量 ${computed.totalQuantity ?? '待确认'}，数量 × 单价合计 ${computed.totalAmount ?? '待确认'}（${latest.draft!.header.currency.value || '币种待确认'}；不自动加减税）。`
            : '';
        latest.messages.push(
          { role: 'user', text: input.message, at: new Date().toISOString() },
          {
            role: 'assistant',
            text:
              result.reply +
              (result.questions.length ? '\n待确认：\n' + result.questions.join('\n') : '') +
              calculation,
            at: new Date().toISOString(),
          },
        );
        this.save(latest, input.expectedRevision, 'ai-chat', changes);
        return this.view(latest);
      },
      attempt,
    );
  }
  undo(id: string, raw: unknown, who?: Actor | null) {
    const { expectedRevision } = revisionSchema.parse(raw),
      w = this.load(id);
    this.check(w, expectedRevision, isLocalAdministrator(who));
    const last = w.history.pop();
    if (!last) throw new ImportError('没有可撤销的草稿修改。');
    w.draft = last.draft;
    w.confirmedRevision = null;
    w.changes = last.changes.map((c) => ({
      ...c,
      before: c.after,
      after: c.before,
      reason: '撤销最近一次修改',
    }));
    this.save(w, expectedRevision, 'undo', w.changes);
    return this.view(w);
  }
  confirm(id: string, raw: unknown, actor?: { id: string; name: string } | null) {
    const { expectedRevision } = revisionSchema
        .extend({ acknowledged: z.literal(true) })
        .parse(raw),
      w = this.load(id);
    this.check(w, expectedRevision);
    if (!w.draft) throw new ImportError('尚无识别草稿。');
    w.confirmedRevision = expectedRevision + 1;
    w.confirmedBy = actor ? { id: actor.id, name: actor.name } : null;
    this.save(w, expectedRevision, 'human-review');
    return this.view(w);
  }
}
