import { resolve } from 'node:path';
import { workspaceEditSchema, workspaceMappingSchema, workspaceRevisionSchema } from '../../shared/import/index.js';
import type { AiProgress } from '../../shared/ai/index.js';
import type { ProviderTokenUsage } from '../ai/index.js';
import { changeArchive, isLocalAdministrator } from '../core/index.js';
import type { Actor } from '../core/index.js';
import { WorkspaceStore, type WorkspaceOptions } from './workspace-store.js';
import * as files from './workspace-files.js';
import { applyDraftOperations, applyMapping, undoDraftEdit } from './order-draft-edits.js';
import { OrderRecognition } from './order-recognition.js';

/**
 * 识别导入对外的总入口（路由、助手、收件箱、数据管理都用它）。
 * 工作区存储在 WorkspaceStore；这里接上归档和永久删除（workspace-files.ts）、
 * 订单识别结果的修改（order-draft-edits.ts）和订单识别（order-recognition.ts）。
 */
export class ImportManager extends WorkspaceStore {
  private recognition: OrderRecognition;
  constructor(options: WorkspaceOptions) {
    super(options);
    files.repairWorkspaceFiles(this.options.directory, this.repo);
    this.recognition = new OrderRecognition(this);
  }
  get archiveDirectory() {
    return this.options.archiveDirectory ? resolve(this.options.archiveDirectory) : undefined;
  }
  // —— 归档和永久删除（软删除只有归档一种） ——
  /** 页面上的归档、恢复（批量，和单据、档案同一个写法） */
  changeArchive(raw: unknown, who: Actor | null | undefined) {
    return changeArchive(raw, who, files.workspaceArchiveTarget(this));
  }
  /** 永久删除（批量，只给本机管理员）：AI 导入页、数据管理、助手都走它 */
  deleteMany(raw: unknown, who: Actor) {
    return files.deleteMany(this, raw, who);
  }
  deleteAllWorkspaces(who: Actor) {
    return files.deleteAllWorkspaces(this, who);
  }
  clearArchive(who: Actor) {
    return files.clearArchive(this.archiveDirectory, who);
  }
  forkWorkspace(id: string, who: Actor) {
    return files.forkWorkspace(this, id, who);
  }
  // —— 订单识别结果的修改 ——
  mapping(id: string, raw: unknown, who?: Actor | null) {
    const v = workspaceMappingSchema.parse(raw),
      w = this.load(id);
    this.check(w, v.expectedRevision, isLocalAdministrator(who));
    applyMapping(w, v.mapping, this.options.validateMapping);
    this.save(w, v.expectedRevision, 'mapping');
    return this.view(w);
  }
  edit(id: string, raw: unknown, origin: 'manual' | 'ai' = 'manual', who?: Actor | null) {
    const input = workspaceEditSchema.parse(raw),
      w = this.load(id);
    this.check(w, input.expectedRevision, isLocalAdministrator(who));
    const changes = applyDraftOperations(w, input.operations, origin);
    this.save(w, input.expectedRevision, origin === 'ai' ? 'assistant-edit' : 'manual-edit', changes);
    return this.view(w);
  }
  undo(id: string, raw: unknown, who?: Actor | null) {
    const { expectedRevision } = workspaceRevisionSchema.parse(raw),
      w = this.load(id);
    this.check(w, expectedRevision, isLocalAdministrator(who));
    const changes = undoDraftEdit(w);
    this.save(w, expectedRevision, 'undo', changes);
    return this.view(w);
  }
  // —— 订单识别 ——
  analyze(
    id: string,
    raw: unknown,
    onProgress?: (event: AiProgress) => void,
    actor?: { id: string; name: string } | null,
    onUsage?: (usage: ProviderTokenUsage) => void,
  ) {
    return this.recognition.analyze(id, raw, onProgress, actor, onUsage);
  }
  enqueue(id: string, raw: unknown, actor?: { id: string; name: string } | null) {
    return this.recognition.enqueue(id, raw, actor);
  }
}
