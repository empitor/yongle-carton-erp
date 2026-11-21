import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { InputError, configDirectory, one, openVersionedSqlite, registerVersionedSqlite, rows } from '../../core/index.js';
import { platformProtector, type SecretProtector } from '../../ai/index.js';
import {
  botChannels,
  botCredentialLabels,
  botSettingsSchema,
  inboxChannelLabels,
  type BotChannel,
} from '../../../shared/import/index.js';
import type { BotCredentials } from './protocol.js';

/** 和 AI 密钥一样放在业务库之外（配置目录下的 bots/bots.sqlite），Secret 只存加密后的内容。 */
export function defaultBotSettingsPath() {
  return join(configDirectory(), 'bots', 'bots.sqlite');
}

/**
 * 机器人设置库：每家一行。基线是 0.9.0 的第 1 版，以后改结构在 steps 加一步（规矩见 server/core/versioned-sqlite-spec.ts 开头）；
 * 建表约束列着 botChannels，再加一家要加一步重建 bots 表（CHECK 不能单独改）。
 */
const botDatabase = {
  label: '机器人设置库',
  baseline: 1,
  steps: [],
  create(db: DatabaseSync) {
    db.exec(
      `CREATE TABLE bots(channel TEXT PRIMARY KEY CHECK(channel IN (${botChannels.map((c) => `'${c}'`).join(',')})),app_id TEXT NOT NULL,secret TEXT NOT NULL,enabled INTEGER NOT NULL,updated_at TEXT NOT NULL)`,
    );
  },
};
// 默认位置登记进配置库登记表：恢复备份时据此认出备份 _extra 里的那一份是机器人设置库、支持到第几版
registerVersionedSqlite(botDatabase, defaultBotSettingsPath);

const botRow = rows.bots.pick({ app_id: true, secret: true, enabled: true });

export class BotSettings {
  private db: DatabaseSync;
  constructor(
    file: string,
    private protector: SecretProtector = platformProtector,
  ) {
    this.db = openVersionedSqlite(file, botDatabase);
  }
  private row(channel: BotChannel) {
    return one(this.db, botRow, 'SELECT app_id,secret,enabled FROM bots WHERE channel=?', channel);
  }
  /** 给页面看的内容，永远不含 Secret。 */
  view(channel: BotChannel) {
    const row = this.row(channel);
    return { appId: row?.app_id ?? '', hasSecret: !!row?.secret, enabled: !!row?.enabled };
  }
  save(channel: BotChannel, raw: unknown) {
    const v = botSettingsSchema.parse(raw),
      old = this.row(channel),
      labels = botCredentialLabels[channel];
    if (!v.appId) throw new InputError('请填写 ' + labels.appId);
    const secret = v.secret ? this.protector.protect(v.secret) : old?.secret;
    if (!secret) throw new InputError('请填写 ' + labels.secret);
    this.db
      .prepare(
        'INSERT INTO bots(channel,app_id,secret,enabled,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(channel) DO UPDATE SET app_id=excluded.app_id,secret=excluded.secret,enabled=excluded.enabled,updated_at=excluded.updated_at',
      )
      .run(channel, v.appId, secret, v.enabled ? 1 : 0, new Date().toISOString());
    return { ...this.view(channel), secretChanged: !!v.secret };
  }
  /** 已启用才返回明文，只给长连接使用。 */
  credentials(channel: BotChannel): BotCredentials | null {
    const row = this.row(channel);
    if (!row?.enabled || !row.secret) return null;
    return { appId: row.app_id, secret: this.protector.unprotect(row.secret) };
  }
  /** 启动时检查：换了服务账号或平台，已存的 Secret 解不开了。 */
  credentialWarning() {
    const broken = botChannels.filter((channel) => {
      const row = this.row(channel);
      if (!row?.secret) return false;
      try {
        this.protector.unprotect(row.secret);
        return false;
      } catch {
        return true;
      }
    });
    if (broken.length)
      return (
        '当前服务账号或平台无法解密已保存的' +
        broken.map((c) => inboxChannelLabels[c]).join('、') +
        ' Secret，请重新填写。'
      );
  }
  close() {
    this.db.close();
  }
}
