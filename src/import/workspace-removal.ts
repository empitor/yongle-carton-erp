import { emit } from '../ui/index';
import { errorMessage } from '../../shared/core/index';
import { load, refresh, selectFirst, tokenOf, type WorkspaceCtx } from './workspace-actions';
import { changeWorkspaceFiles, readWorkspace, type RemovalResult } from './workspace-api';

/**
 * 批量归档或永久删除 AI 导入里的文件，和从归档恢复：先读每份的版本号，读不到的直接算没办成；结果拼成一句话。
 * 软删除只有归档（有业务编辑权限就行，能恢复）；永久删除只给本机管理员。
 * 请求和结果的写法和单据、档案的归档一样：items 是 { id, version }，结果逐份 { id, success, message }。
 */
export type RemovalTarget = { id: string; revision: number | null; error: string };

export function removalPlan(targets: RemovalTarget[]) {
  return {
    ready: targets.flatMap((t) => (t.revision === null ? [] : [{ id: t.id, version: t.revision }])),
    /** 读不到版本号的，直接算没办成 */
    unreadable: targets
      .filter((t) => t.revision === null)
      .map((t): RemovalResult => ({ id: t.id, success: false, message: t.error })),
  };
}

export function removalNotice(results: RemovalResult[], nameOf: (id: string) => string, permanent: boolean) {
  const done = results.filter((r) => r.success).length,
    failed = results.filter((r) => !r.success);
  return (
    (permanent ? '已永久删除' : '已归档') +
    done +
    '份文件' +
    (failed.length
      ? '；没办成' + failed.length + '份：' + failed.map((r) => nameOf(r.id) + '：' + r.message).join('；')
      : permanent
        ? '，不能恢复。'
        : '，在“更多 → 历史与归档”里能恢复。')
  );
}

/** 一份的版本号：内容读不出来的那几份用列表给的版本号（打不开，但能永久删除）；别的现读一次，读不到的记下原因 */
async function targetOf(ctx: WorkspaceCtx, id: string): Promise<RemovalTarget> {
  const unreadable = ctx.status.current?.unreadable.find((u) => u.id === id);
  if (unreadable) return { id, revision: unreadable.revision, error: '' };
  try {
    return { id, revision: (await readWorkspace(id)).revision, error: '' };
  } catch (error) {
    return { id, revision: null, error: errorMessage(error) };
  }
}

/** 读每份的版本号，按读到的归档或删除；读不到的算没办成 */
async function removeTargets(ctx: WorkspaceCtx, ids: string[], permanent: boolean) {
  const plan = removalPlan(await Promise.all(ids.map((id) => targetOf(ctx, id))));
  const results: RemovalResult[] = plan.ready.length
    ? (await changeWorkspaceFiles(permanent ? 'delete' : 'archive', plan.ready, tokenOf(ctx))).results
    : [];
  return [...results, ...plan.unreadable];
}

/** 批量归档（permanent=false），或永久删除（只给本机管理员）；返回办成的 id */
export async function removeMany(ctx: WorkspaceCtx, ids: string[], permanent = false) {
  ids.forEach((id) => ctx.cancelled.add(id));
  try {
    const results = await removeTargets(ctx, ids, permanent);
    const removed = results.filter((r) => r.success).map((r) => r.id);
    ctx.forget(removed);
    for (const r of results) if (!r.success) ctx.cancelled.delete(r.id);
    const state = await refresh(ctx);
    // 待处理的识别文件少了：让导航角标、今日页马上重新数，不等每分钟那一次
    if (removed.length) emit('erp-business-changed');
    const current = ctx.selected.current;
    if (removed.includes(current) || !state.workspaces.some((w) => w.id === current))
      await selectFirst(ctx, state);
    const failed = results.filter((r) => !r.success && state.workspaces.some((w) => w.id === r.id));
    await Promise.all(failed.map((r) => load(ctx, r.id)));
    ctx.setNotice(removalNotice(results, (id) => ctx.cache.current[id]?.fileName || id, permanent));
    return removed;
  } catch (error) {
    ids.forEach((id) => ctx.cancelled.delete(id));
    ctx.setFatal(errorMessage(error));
    await refresh(ctx).catch(() => {
      // 没办成的原因已经显示在页头；列表这次没重读到，下一次定时、切回页面时再读
    });
    return [];
  }
}

/** 从归档恢复，回到文件列表并选中它 */
export async function restore(ctx: WorkspaceCtx, id: string) {
  try {
    ctx.cancelled.delete(id);
    const version = ctx.status.current?.archives?.find((a) => a.id === id)?.revision;
    if (version === undefined) throw Error('归档列表里没有这份文件，请刷新后再试。');
    const [result] = (await changeWorkspaceFiles('restore', [{ id, version }], tokenOf(ctx))).results;
    if (!result.success) throw Error(result.message);
    ctx.accept(await readWorkspace(id));
    ctx.select(id);
    await refresh(ctx);
    emit('erp-business-changed');
    ctx.setNotice('已从归档恢复，回到文件列表');
  } catch (e) {
    ctx.setFatal(errorMessage(e));
  }
}
