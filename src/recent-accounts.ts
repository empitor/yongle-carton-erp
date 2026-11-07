/** 这台设备用过的账号。只记用户名，不记密码或令牌。 */
const KEY = 'erp-recent-accounts';
const LIMIT = 5;
export type RecentAccount = { name: string; at: string };
type Store = Pick<Storage, 'getItem' | 'setItem'>;

export function readRecentAccounts(storage: Store): RecentAccount[] {
  try {
    const list = JSON.parse(storage.getItem(KEY) || '[]');
    if (!Array.isArray(list)) return [];
    return list
      .filter((a) => typeof a?.name === 'string' && a.name && typeof a?.at === 'string')
      .slice(0, LIMIT);
  } catch {
    return [];
  }
}
function save(storage: Store, list: RecentAccount[]) {
  try {
    storage.setItem(KEY, JSON.stringify(list));
  } catch {
    // 浏览器禁用本地存储时不记，登录照常。
  }
}
export function rememberAccount(storage: Store, name: string, now = new Date()) {
  const list = readRecentAccounts(storage).filter((a) => a.name !== name);
  save(storage, [{ name, at: now.toISOString() }, ...list].slice(0, LIMIT));
}
export function forgetAccount(storage: Store, name: string) {
  const list = readRecentAccounts(storage).filter((a) => a.name !== name);
  save(storage, list);
  return list;
}
export function lastUsedLabel(at: string, now = new Date()) {
  const then = new Date(at);
  if (Number.isNaN(then.getTime())) return '';
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(then)) / 86400000);
  if (days <= 0) return '今天用过';
  if (days === 1) return '昨天用过';
  return then.getMonth() + 1 + ' 月 ' + then.getDate() + ' 日用过';
}
