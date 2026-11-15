import { randomUUID, createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { z } from 'zod';
import {
  evaluateDraft,
  type ImportWorkspaceView,
  type DraftChange,
  type ImportMapping,
  arrivalLinkSchema,
  ORIGINAL_MAX_MB,
  recognitionModes,
  workspaceId,
  workspaceModeSchema,
  workspaceRevisionSchema,
  type RecognitionMode,
} from '../../shared/import/index.js';
import { AiSettingsManager, PromptPresetManager } from '../ai/index.js';
import { AppError, FILE_NAME_MAX, StoredDataError } from '../core/index.js';
import { MIB } from '../../shared/core/index.js';
import { storeOriginal, detectFormat } from './file-store.js';
import { ImportRepository } from './repository.js';
import { failureRecord, type FailureContext, type FailureSubject } from './failure-record.js';
import { PROMPT_VERSION } from './prompts.js';
import { workspaceText, type Workspace } from './workspace-document.js';
import type { ArrivalLinks } from './business-links.js';

/**
 * 识别工作区的存储：工作区库的读写和版本、原件、各识别类型的状态存取、任务状态、错误档案。
 * 订单、到货、收件箱、数据管理都只用这一层；归档和永久删除在 workspace-files.ts，
 * 订单识别和识别结果的修改在 order-recognition.ts、order-draft-edits.ts。
 */
export type WorkspaceView = ImportWorkspaceView;
/** 一份工作区最多记多少次操作、存多大 */
const MAX_AUDITS = 300;
const WORKSPACE_MAX_MB = 20;
/** 本机最多存多少份原件、原件合计多大 */
const MAX_WORKSPACES = 200;
const ORIGINALS_MAX_MB = 500;
export type WorkspaceOptions = {
  directory: string;
  /** 正式导入的原件归档目录。只由启动入口明确传入；不传时初始化不清理任何归档。 */
  archiveDirectory?: string;
  settings: AiSettingsManager;
  database?: string;
  promptPresets?: PromptPresetManager;
  findImport?: (id: string, hash?: string) => ImportWorkspaceView['imported'];
  validateMapping?: (mapping: ImportMapping) => void;
};

export class WorkspaceStore {
  /** 到货单在不在、锁没锁、怎么停到货识别：装配时用 connectArrivals 一次接好（business-links.ts） */
  private arrivals?: ArrivalLinks;
  readonly promptPresets: PromptPresetManager;
  /** 下面四个只给本模块的目录操作和订单识别用 */
  readonly repo: ImportRepository;
  readonly busy = new Map<string, AbortController>();
  readonly importing = new Set<string>();
  readonly deleting = new Set<string>();
  private uploading = false;
  constructor(readonly options: WorkspaceOptions) {
    options.directory = resolve(options.directory);
    this.promptPresets = options.promptPresets || new PromptPresetManager();
    this.repo = new ImportRepository(options.database || join(options.directory, 'workspaces.sqlite'));
  }
  close() {
    for (const controller of this.busy.values()) controller.abort();
    this.repo.close();
    if (!this.options.promptPresets) this.promptPresets.close();
  }
  connectArrivals(links: ArrivalLinks) {
    this.arrivals = links;
  }
  /** 关联的到货单已确认或取消：不能再换识别类型 */
  arrivalLocked(docId: number) {
    return !!this.arrivals?.locked(docId);
  }
  abortArrival(sourceId: string) {
    this.arrivals?.abort?.(sourceId);
  }
  isBusy(id: string) {
    return this.busy.has(id);
  }
  get csrfToken() {
    return this.options.settings.csrfToken;
  }
  archives() {
    return this.repo.archived();
  }
  private tags(w: { id: string; fileHash: string }) {
    const ref = this.options.findImport?.(w.id, w.fileHash);
    const own = ref && !ref.historical ? ref : undefined;
    return { imported: own, historyImport: own ? undefined : ref };
  }
  /**
   * 工作区与业务库独立保存；列表前解除已物理删除的到货单引用，保留独立的识别结果。
   * 一次批量查出还在的到货单，只重新读取、保存引用已失效的那几份；有解除时重新列一次，拿到新版本号。
   */
  private detachDeletedArrivals(listed: ReturnType<ImportRepository['list']>) {
    if (!this.arrivals) return listed;
    const linked = listed.workspaces.flatMap((r) => (r.arrivalDocId ? [{ id: r.id, docId: r.arrivalDocId }] : []));
    if (!linked.length) return listed;
    const found = this.arrivals.exists([...new Set(linked.map((r) => r.docId))]),
      stale = linked.filter((r) => !found.has(r.docId));
    for (const r of stale) this.detachIfReadable(r.id);
    return stale.length ? this.repo.list() : listed;
  }
  /** 读一份就会解除它失效的到货单引用（load）；内容对不上结构的那份已记日志，打开时照样报，这里不为它挡住列表 */
  private detachIfReadable(id: string) {
    try {
      this.load(id);
    } catch (error) {
      if (!(error instanceof StoredDataError)) throw error;
    }
  }
  /**
   * 识别文件列表：在用的（带导入过没有）、归档的，和内容对不上结构、读不出来的（unreadable：编号、版本号、说明，能永久删除）。
   * 识别导入页、数据管理页、助手都从这里拿。
   */
  workspaceLists() {
    const listed = this.detachDeletedArrivals(this.repo.list());
    return {
      active: listed.workspaces.map((w) => ({ ...w, ...this.tags(w) })),
      archived: this.archives(),
      unreadable: listed.unreadable,
    };
  }
  status() {
    const { active, archived, unreadable } = this.workspaceLists();
    return {
      csrfToken: this.csrfToken,
      ai: this.options.settings.status(),
      workspaces: active,
      archives: archived,
      unreadable,
      promptVersion: PROMPT_VERSION,
      limits: { maxFileMB: ORIGINAL_MAX_MB },
      queue: this.options.settings.workQueue.stats(),
    };
  }
  load(id: string): Workspace {
    workspaceId.parse(id);
    const w = this.repo.get(id);
    if (!w) throw new AppError('导入工作区不存在。', 404);
    if (w.arrivalDocId && this.arrivals && !this.arrivals.exists([w.arrivalDocId]).has(w.arrivalDocId)) {
      w.arrivalDocId = null;
      this.save(w, w.revision, 'detach-deleted-arrival');
    }
    return w;
  }
  view(w: Workspace): WorkspaceView {
    const { history, audits, ...view } = w;
    const tags = this.tags(w);
    return {
      ...view,
      imported: tags.imported ?? view.imported,
      historyImport: tags.historyImport,
      parsed: { format: view.parsed.format },
      evaluation: w.draft ? evaluateDraft(w.draft) : null,
      canUndo: history.length > 0,
    };
  }
  get(id: string) {
    return this.view(this.load(id));
  }
  /** 页面、收件箱和助手切换识别类型都走这里，锁定规则只有一份。 */
  setMode(id: string, raw: unknown) {
    const input = workspaceModeSchema.parse(raw),
      w = this.load(id);
    this.check(w, input.expectedRevision);
    if (w.mode === input.mode) return this.view(w);
    if (w.arrivalDocId && this.arrivalLocked(w.arrivalDocId))
      throw new AppError('到货单已确认或取消，识别类型已锁定，请保留原记录。', 409);
    w.mode = input.mode;
    this.save(w, input.expectedRevision, 'mode');
    return this.view(w);
  }
  linkArrival(id: string, raw: unknown) {
    const input = arrivalLinkSchema.parse(raw),
      w = this.load(id);
    this.check(w, input.expectedRevision);
    w.arrivalDocId = input.docId;
    if (input.sourceId !== undefined) w.arrivalSourceId = input.sourceId;
    this.save(w, input.expectedRevision, 'arrival-draft-link');
    return this.view(w);
  }
  /** 读原件并核对哈希 */
  async original(id: string) {
    const w = this.load(id);
    const bytes = await readFile(join(this.options.directory, w.id, 'original'));
    if (createHash('sha256').update(bytes).digest('hex') !== w.fileHash)
      throw new AppError('原件完整性校验失败。', 409, 'source');
    return { bytes, fileName: w.fileName };
  }
  check(w: Workspace, revision: number, allowImported = false) {
    if (this.importing.has(w.id)) throw new AppError('正在提交正式导入，请等待完成。', 409, 'busy');
    const imported = this.options.findImport?.(w.id, w.fileHash);
    if (!allowImported && imported && !imported.historical)
      throw new AppError(
        '该工作区已导入正式订单，不能继续修改；如需再次导入同一原件，请重新上传建立新的导入任务。',
        409,
        'imported',
      );
    if (w.revision !== revision) throw new AppError('识别结果已变化，请刷新后核对最新版本。', 409, 'stale');
  }
  save(w: Workspace, expected: number, kind: string, changes: DraftChange[] = []) {
    if (this.deleting.has(w.id) || !this.repo.get(w.id))
      throw new AppError('任务已取消或文件已删除。', 409, 'cancelled');
    w.revision = expected + 1;
    w.audits.push({ at: new Date().toISOString(), kind, revision: w.revision, changes });
    if (w.audits.length > MAX_AUDITS) throw new AppError('本工作区操作记录超过 300 次，请另建工作区。');
    const document = workspaceText(w);
    if (Buffer.byteLength(document) > WORKSPACE_MAX_MB * MIB)
      throw new AppError('工作区历史超过 20 MB，请另建工作区。');
    try {
      this.repo.save(w, expected, document);
    } catch {
      // 版本对不上（别人先改了）和写盘出错都在这里，对人只说这一句
      throw new AppError('识别结果保存冲突或磁盘不可写，请刷新后重试。', 409, 'storage');
    }
  }
  /**
   * 保存原件并建立识别任务，新任务直接是 mode 指定的识别类型。
   * 相同原件只复用同一类型、没归档、没识别结果、没关联到货的任务，避免重复占用原件；
   * 已识别、已导入、换过类型或已归档的相同文件重新上传时建立独立任务，不能阻止再次识别。
   */
  async upload(buffer: Buffer, fileName: string, isolate = false, mode: RecognitionMode = 'order') {
    if (this.uploading) throw new AppError('正在保存其他原文件，请稍候。', 429, 'busy');
    mode = z.enum(recognitionModes).parse(mode);
    detectFormat(buffer, fileName);
    const hash = createHash('sha256').update(buffer).digest('hex'),
      sibling =
        !isolate &&
        this.repo.reusableByHash(hash, mode).find((w) => {
          const ref = this.options.findImport?.(w.id, w.fileHash);
          return !(ref && !ref.historical);
        });
    if (sibling) return { workspace: this.view(sibling), duplicate: true };
    const stats = this.repo.stats();
    if (stats.count >= MAX_WORKSPACES || stats.bytes + buffer.length > ORIGINALS_MAX_MB * MIB)
      throw new AppError(
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
        fileName: fileName.replace(/[\r\n\x00-\x1f]/g, '').slice(0, FILE_NAME_MAX),
        fileHash: hash,
        size: buffer.length,
        createdAt: new Date().toISOString(),
        parsed,
        draft: null,
        evaluation: null,
        changes: [],
        canUndo: false,
        history: [],
        audits: [],
        task: { state: 'uploaded' },
        promptVersion: PROMPT_VERSION,
        mode,
        arrivalDocId: null,
        arrivalSourceId: null,
      };
      this.repo.insert(w);
      return { workspace: this.view(w), duplicate: false };
    } catch (error) {
      if (dirname(resolve(directory)) !== this.options.directory) throw new AppError('工作区路径校验失败。');
      await rm(directory, { recursive: true, force: true });
      throw error;
    } finally {
      this.uploading = false;
    }
  }
  cancel(id: string, raw: unknown) {
    const { expectedRevision } = workspaceRevisionSchema.parse(raw),
      w = this.load(id);
    this.check(w, expectedRevision);
    this.busy.get(id)?.abort();
    if (w.arrivalSourceId) this.abortArrival(w.arrivalSourceId);
    this.repo.task(id, { state: 'cancelled' });
    w.task = { state: 'cancelled' };
    this.save(w, expectedRevision, 'cancel-task');
    return this.get(id);
  }
  abortRequest(id: string) {
    this.busy.get(id)?.abort();
  }
  async file(id: string) {
    const w = this.load(id);
    return {
      bytes: await readFile(join(this.options.directory, id, 'original')),
      name: w.fileName,
      mime: w.parsed.format === 'jpg' ? 'image/jpeg' : w.parsed.format === 'png' ? 'image/png' : 'application/octet-stream',
    };
  }
  /** 正式导入时独占工作区并读出原件 */
  async withImportSource<T>(
    id: string,
    revision: number,
    job: (w: ImportWorkspaceView, bytes: Buffer) => Promise<T>,
  ): Promise<T> {
    const w = this.get(id);
    if (this.busy.has(id) || this.importing.has(id)) throw new AppError('工作区任务尚未结束，请稍后操作。', 409);
    if (w.revision !== revision) throw new AppError('识别结果已变化，请重新生成导入预览。', 409);
    this.importing.add(id);
    try {
      const bytes = await readFile(join(this.options.directory, id, 'original'));
      if (createHash('sha256').update(bytes).digest('hex') !== w.fileHash)
        throw new AppError('来源文件完整性校验失败。', 409);
      return await job(w, bytes);
    } finally {
      this.importing.delete(id);
    }
  }
  failures(workspaceId?: string, offset = 0) {
    return this.repo.failures(workspaceId, offset);
  }
  failure(id: string) {
    const r = this.repo.failure(workspaceId.parse(id));
    if (!r) throw new AppError('错误记录不存在。', 404);
    return r;
  }
  recordFailure(error: unknown, w: FailureSubject, context: FailureContext) {
    const record = failureRecord(error, w, context);
    this.repo.addFailure(record);
    return record.id;
  }
}
