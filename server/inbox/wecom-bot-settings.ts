import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { InputError } from '../db.js';
import {
  defaultAiSettingsPath,
  platformProtector,
  type SecretProtector,
} from '../ai/credential-store.js';

export const wecomBotInputSchema = z.strictObject({
  botId: z.string().trim().min(1, '请填写 Bot ID').max(128),
  // 留空表示沿用已保存的 Secret。
  secret: z.string().trim().max(512).optional(),
  enabled: z.boolean(),
});

/** 和 AI 密钥一样放在业务库之外，Secret 只存加密后的内容。 */
export function defaultWecomBotPath() {
  return join(dirname(dirname(defaultAiSettingsPath())), 'wecom', 'bot.sqlite');
}

export class WecomBotSettings {
  private db: DatabaseSync;
  constructor(
    file: string,
    private protector: SecretProtector = platformProtector,
  ) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS bot(id INTEGER PRIMARY KEY CHECK(id=1),bot_id TEXT NOT NULL,secret TEXT NOT NULL,enabled INTEGER NOT NULL,updated_at TEXT NOT NULL)',
    );
  }
  private row() {
    return this.db.prepare('SELECT bot_id,secret,enabled FROM bot WHERE id=1').get() as
      | { bot_id: string; secret: string; enabled: number }
      | undefined;
  }
  /** 给页面看的内容，永远不含 Secret。 */
  view() {
    const row = this.row();
    return { botId: row?.bot_id ?? '', hasSecret: !!row?.secret, enabled: !!row?.enabled };
  }
  save(raw: unknown) {
    const v = wecomBotInputSchema.parse(raw),
      old = this.row();
    const secret = v.secret ? this.protector.protect(v.secret) : old?.secret;
    if (!secret) throw new InputError('请填写 Secret');
    this.db
      .prepare(
        'INSERT INTO bot(id,bot_id,secret,enabled,updated_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET bot_id=excluded.bot_id,secret=excluded.secret,enabled=excluded.enabled,updated_at=excluded.updated_at',
      )
      .run(v.botId, secret, v.enabled ? 1 : 0, new Date().toISOString());
    return { ...this.view(), secretChanged: !!v.secret };
  }
  /** 已启用才返回明文，只给长连接使用。 */
  credentials() {
    const row = this.row();
    if (!row?.enabled || !row.secret) return null;
    return { botId: row.bot_id, secret: this.protector.unprotect(row.secret) };
  }
  credentialWarning() {
    const row = this.row();
    if (!row?.secret) return;
    try {
      this.protector.unprotect(row.secret);
    } catch {
      return '当前服务账号或平台无法解密已保存的企业微信机器人 Secret，请重新填写。';
    }
  }
  close() {
    this.db.close();
  }
}
