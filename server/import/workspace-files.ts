import { rm, rename, mkdir } from 'node:fs/promises';
import { existsSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { AppError, failureMessage, requireLocalAdministrator } from '../core/index.js';
import type { Actor, ArchiveTarget } from '../core/index.js';
import type { ImportRepository } from './repository.js';
import type { WorkspaceStore } from './workspace-store.js';
import type { Workspace } from './workspace-document.js';
import { WORKSPACE_FIRST_VERSION, workspaceDeleteSchema, workspaceId } from '../../shared/import/index.js';

/**
 * 识别工作区的归档和永久删除。软删除只有“归档”一种：文件和识别结果原地保留，列表里不再出现，
 * 在“历史与归档”里能恢复；永久删除只给本机管理员，先把原件目录搬到 _deleting 再删库，库写失败就搬回去。
 */

/** 重启修复：永久删除搬到一半的，库里还有就搬回去，库里没有就删掉。 */
export function repairWorkspaceFiles(directory: string, repo: ImportRepository) {
  const staging = resolve(directory, '_deleting');
  if (!existsSync(staging)) return;
  for (const id of readdirSync(staging)) {
    if (!workspaceId.safeParse(id).success) continue;
    const target = resolve(staging, id);
    if (dirname(target) !== staging) continue;
    if (repo.has(id)) renameSync(target, resolve(directory, id));
    else rmSync(target, { recursive: true, force: true });
  }
}

/** 两个目录位置，路径越界就拒绝 */
function paths(store: WorkspaceStore, id: string) {
  const base = resolve(store.options.directory),
    active = resolve(base, id),
    stage = resolve(base, '_deleting', id);
  return { base, active, stage, ok: dirname(active) === base && dirname(stage) === resolve(base, '_deleting') };
}

/** 归档：取消正在进行的识别，标成已归档，能恢复。权限由调用方查（业务编辑权限就行）。 */
export function archiveWorkspace(store: WorkspaceStore, id: string, revision: number) {
  const w = store.load(id);
  if (store.importing.has(id)) throw new AppError('正在提交正式导入，请稍后归档。', 409);
  store.check(w, revision, true);
  store.busy.get(id)?.abort();
  if (w.arrivalSourceId) store.abortArrival(w.arrivalSourceId);
  w.archived = true;
  store.save(w, revision, 'archive');
  return store.get(id);
}
/**
 * 归档、恢复走全站同一份做法（server/core/records/archive.ts 的 changeArchive）；这里只给识别文件存在哪、怎么打标记：
 * 编号是 UUID，版本是工作区的 revision（从 0 起），审计记在工作区自己的修改记录里。
 */
export function workspaceArchiveTarget(store: WorkspaceStore): ArchiveTarget<string, Workspace> {
  return {
    id: workspaceId,
    firstVersion: WORKSPACE_FIRST_VERSION,
    load(id) {
      const w = store.repo.get(id);
      return w ? { label: '识别文件', version: w.revision, archived: !!w.archived, row: w } : undefined;
    },
    blocked: (id) => (store.importing.has(id) ? '正在提交正式导入，请稍后归档。' : null),
    write(id, archive, _actor, found) {
      if (archive) archiveWorkspace(store, id, found.row.revision);
      else unarchiveWorkspace(store, id);
    },
    // 一份只写一次工作区库，本身就是整条成或不成
    transaction: (job) => job(),
  };
}
/** 从归档恢复到列表里。权限由调用方查。 */
export function unarchiveWorkspace(store: WorkspaceStore, id: string) {
  const w = store.load(id);
  w.archived = false;
  store.save(w, w.revision, 'restore-archive');
  return store.get(id);
}
/** 永久删除一份（归档的或没归档的都行），只给本机管理员。 */
export async function deleteWorkspace(store: WorkspaceStore, id: string, revision: number | undefined, who: Actor) {
  requireLocalAdministrator(who);
  workspaceId.parse(id);
  const w = store.repo.deletionFacts(id);
  if (w && revision !== undefined && w.revision !== revision) throw new AppError('工作区版本已变化，请刷新。', 409);
  if (store.importing.has(id)) throw new AppError('工作区正在提交数据库事务，请完成后重试删除。', 409);
  store.busy.get(id)?.abort();
  if (w?.arrivalSourceId) store.abortArrival(w.arrivalSourceId);
  store.deleting.add(id);
  const p = paths(store, id);
  if (!p.ok) throw new AppError('工作区路径异常。');
  const source = existsSync(p.active) ? p.active : null;
  try {
    await mkdir(resolve(p.base, '_deleting'), { recursive: true });
    if (source) await rename(source, p.stage);
    try {
      store.repo.physicalDelete(id);
    } catch (e) {
      if (source) await rename(p.stage, source);
      throw e;
    }
    await rm(p.stage, { recursive: true, force: true });
    return { id, deleted: true, recoverable: false };
  } finally {
    store.deleting.delete(id);
  }
}
/** 批量永久删除，逐份给结果（和归档一样的 { id, success, message }）。只给本机管理员。 */
export async function deleteMany(store: WorkspaceStore, raw: unknown, who: Actor) {
  requireLocalAdministrator(who);
  const { items } = workspaceDeleteSchema.parse(raw);
  const results = [];
  for (const item of items) {
    try {
      await deleteWorkspace(store, item.id, item.version, who);
      results.push({ id: item.id, success: true, message: '已从数据库和文件系统删除' });
    } catch (e) {
      results.push({
        id: item.id,
        success: false,
        message: failureMessage(e, '永久删除识别文件 ' + item.id, '删除失败，原文件保留，请刷新后重试。'),
      });
    }
  }
  return { results };
}
/**
 * 开发初始化：一次性清空所有识别工作区和失败记录。
 * 与逐条 deleteWorkspace 分离，避免级联/版本校验把“批量清空”拖成几十次失败。
 */
export function deleteAllWorkspaces(store: WorkspaceStore, who: Actor) {
  requireLocalAdministrator(who);
  const ids = store.repo.allIds(),
    failed: string[] = [];
  const busy = ids.filter((id) => store.importing.has(id) || store.busy.has(id));
  if (busy.length) throw new AppError('部分工作区正在识别或提交，请稍后重试批量清理。', 409);
  let count = 0;
  for (const id of ids) {
    if (!workspaceId.safeParse(id).success) continue;
    const p = paths(store, id);
    if (!p.ok) {
      failed.push(id);
      continue;
    }
    store.deleting.add(id);
    try {
      const w = store.repo.deletionFacts(id);
      if (w?.arrivalSourceId) store.abortArrival(w.arrivalSourceId);
      rmSync(p.active, { recursive: true, force: true });
      rmSync(p.stage, { recursive: true, force: true });
      store.repo.physicalDelete(id);
      count++;
    } catch {
      failed.push(id);
    } finally {
      store.deleting.delete(id);
    }
  }
  return { count, ids, failed };
}
/**
 * 初始化清空导入台账后，原件归档没有任何记录再引用，跟着清掉，不把客户文件留在服务器上。
 * 只删归档目录下按文件哈希命名的子目录，目录本身保留。返回删掉的原件份数。
 */
export function clearArchive(base: string, who: Actor) {
  requireLocalAdministrator(who);
  if (!existsSync(base)) return 0;
  let count = 0;
  for (const name of readdirSync(base)) {
    const target = resolve(base, name);
    if (dirname(target) !== base) continue;
    rmSync(target, { recursive: true, force: true });
    count++;
  }
  return count;
}
/** 用同一原件另建一份工作区，带上识别结果和匹配 */
export async function forkWorkspace(store: WorkspaceStore, id: string, who: Actor) {
  requireLocalAdministrator(who);
  const old = store.load(id),
    original = await store.original(id);
  if (store.isBusy(id) || store.importing.has(id)) throw new AppError('请先等待或取消正在执行的任务。', 409);
  const created = await store.upload(original.bytes, original.fileName, true, old.mode),
    next = store.load(created.workspace.id);
  next.draft = structuredClone(old.draft);
  next.mode = old.mode;
  next.mapping = structuredClone(old.mapping);
  next.arrivalSourceId = old.arrivalSourceId;
  next.arrivalDocId = null;
  next.task = { state: next.draft ? 'ready' : 'uploaded' };
  store.save(next, next.revision, 'fork');
  return store.get(next.id);
}
