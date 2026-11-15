import type { Store } from '../core/index.js';
import type { Actor } from '../core/index.js';
import { audit, exists } from '../core/index.js';
import { errorMessage } from '../../shared/core/index.js';
// 初始化清空导入台账以后删正式导入留下的原件归档：不在事务里就当场删；还在外层事务里就等外层提交了再删，外层回滚就留着。

/** 外层事务还没结束时，隔多久再看一次 */
const RETRY_MS = 200;
/** 最多看几次（共 5 分钟）：外层事务一直不结束就放弃，原件留着，下次初始化时会清掉 */
const MAX_TRIES = 1500;

/** 删除原件归档。失败不推翻已完成的初始化，只记警告，提示检查权限后再初始化一次。 */
export function clearArchiveNow(
  store: Store,
  actor: Actor,
  scope: string,
  resetId: string,
  clear: () => number,
): { archives: number; warning?: string } {
  try {
    const archives = clear();
    try {
      audit(store, actor, { action: 'business-reset-archive', entity: scope, id: null, document: { resetId, archives } });
    } catch (e) {
      // 原件已删，审计补记失败不影响结果；打日志留下没记上的这一笔
      console.error('[初始化] 原件归档已删除，审计没有记上：' + errorMessage(e));
    }
    return { archives };
  } catch (error) {
    const warning =
      '业务数据已清空，但原件归档没有删干净：' +
      (errorMessage(error) || '未知错误') +
      '。请检查目录权限后再初始化一次，或手动清理原件归档目录。';
    try {
      audit(store, actor, { action: 'business-reset-warning', entity: scope, id: null, document: { resetId, warning } });
    } catch (e) {
      // 警告已随结果返回；打日志留下没记上的这一笔
      console.error('[初始化] ' + warning + '（审计没有记上：' + errorMessage(e) + '）');
    }
    return { archives: 0, warning };
  }
}

/** 等外层事务提交后再删的那一次初始化：哪个库、谁办的、范围、初始化编号和它那条审计、怎么删 */
type DeferredCleanup = {
  store: Store;
  actor: Actor;
  scope: string;
  resetId: string;
  auditRow: number;
  clear: () => number;
};

/**
 * 外层事务提交后再删原件归档。node:sqlite 没有提交回调，所以等当前同步调用结束后检查：
 * 不在事务里、且本次初始化的审计行还在（说明已提交）才删；审计行没了说明外层回滚，原件保留。
 * 外层事务一直不结束就放弃（MAX_TRIES），原件留着，下次初始化时会清掉。
 */
export function deferArchiveCleanup(cleanup: DeferredCleanup) {
  const { store, actor, scope, resetId, auditRow, clear } = cleanup;
  const db = store.db;
  let tries = 0;
  const attempt = () => {
    // 数据库已经关了（进程收尾、测试关库）：这次初始化的结果没法再核对，原件留着，下次初始化时会清掉
    if (!db.isOpen) return;
    if (db.isTransaction) {
      if (++tries < MAX_TRIES) setTimeout(attempt, RETRY_MS).unref();
      return;
    }
    let committed: boolean;
    try {
      committed = exists(
        db,
        "SELECT 1 FROM business_audit WHERE id=? AND action='business-reset' AND json_extract(document,'$.resetId')=?",
        auditRow,
        resetId,
      );
    } catch (e) {
      // 在定时器里：往外抛会让进程退出。这次不删，原件留着，下次初始化时会清掉
      console.error('[初始化] 核对外层事务有没有提交时出错，原件归档这次不删：' + errorMessage(e));
      return;
    }
    if (committed) clearArchiveNow(store, actor, scope, resetId, clear);
  };
  setImmediate(attempt);
}
