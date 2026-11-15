import type { Store } from '../core/index.js';
import { inSavepoint } from '../core/index.js';
import { DAY_MS } from '../../shared/core/index.js';
import type { InboxStatus } from '../../shared/import/index.js';

/** 收件箱里没转成业务单据的消息留多少天（按收到的时间算）：到期连原文和附件一起清掉。 */
export const INBOX_KEEP_DAYS = 180;
const CONVERTED: InboxStatus = 'converted';

/**
 * 每日清理调：清掉到期的待处理和已忽略收件，已处理的留着（转单和“标为已处理”写进库的都是 converted）；
 * 附件按内容只存一份，没有收件再用的才删。返回清了几条收件。
 * 不拍删除前快照（snapshotBeforeDestructive）：这是用户定的定时保留规则，不是有人手动发起的删除，
 * 和同批清理的导出文件一样只在日志里记条数；每天拍一次等于每天复制整个库，和清理的目的相反，每日备份照常在。
 */
export function purgeOldInbox(store: Store, keepDays = INBOX_KEEP_DAYS, now = new Date()) {
  const cutoff = new Date(now.getTime() - keepDays * DAY_MS).toISOString();
  const db = store.db;
  return inSavepoint(db, () => {
    // 收到时间可能带时区写法（+08:00），按时间比较，不按字面比较
    const removed = Number(
      db
        .prepare('DELETE FROM inbox_items WHERE status<>? AND julianday(received_at)<julianday(?)')
        .run(CONVERTED, cutoff).changes,
    );
    if (removed)
      db.exec(
        'DELETE FROM inbox_files WHERE sha256 NOT IN (SELECT file_sha256 FROM inbox_items WHERE file_sha256 IS NOT NULL)',
      );
    return removed;
  });
}
