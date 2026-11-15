// 只管：按账号的助手设置（一个账号一组“名字 → 值”），比如自动记忆开没开。和长期记忆一起放在助手设置库
// （ai-tools/tools.sqlite），不进业务库；表 assistant_account_settings 在 tool-registry.ts 建（配置库的建表语句只放在建库的那个文件里）。
// 新的设置项不用改表，换个名字存就行。
import type { DatabaseSync } from 'node:sqlite';
import { one, rows } from '../core/index.js';

export class AssistantAccountSettings {
  constructor(private readonly db: DatabaseSync) {}
  /** 没存过返回 undefined，由用的地方决定默认值。 */
  get(userId: string, name: string): string | undefined {
    const row = one(this.db, rows.assistant_account_settings.pick({ value: true }), 'SELECT value FROM assistant_account_settings WHERE user_id=? AND name=?', userId, name);
    return row?.value;
  }
  set(userId: string, name: string, value: string) {
    this.db
      .prepare(
        'INSERT INTO assistant_account_settings(user_id,name,value,updated_at) VALUES(?,?,?,?) ' +
          'ON CONFLICT(user_id,name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
      )
      .run(userId, name, value, new Date().toISOString());
  }
  /** 账号删掉时把它的设置一起删（现在账号只能停用，没有删除；有了删除时调用）。 */
  forgetAccount(userId: string) {
    this.db.prepare('DELETE FROM assistant_account_settings WHERE user_id=?').run(userId);
  }
}
