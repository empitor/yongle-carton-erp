import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ConflictError, one, openVersionedSqlite, parseStoredJson, registerVersionedSqlite, rows } from '../core/index.js';
import { concurrencySchema } from '../../shared/ai/index.js';
import { defaultAiSettingsPath } from './credential-store.js';

/** 加密后的密钥、保存时间这两个文字字段的长度上限 */
const TEXT_LIMITS = { encryptedKey: 20000, savedAt: 40 } as const;
/** 设置文档的格式号：0.8.4 存的多套预设没有这个字段 */
const DOCUMENT_FORMAT = 2;
/** 设置文档：只有一个加密后的 DeepSeek 密钥。读库和写库都按这份结构核对。 */
const documentSchema = z.strictObject({
  format: z.literal(DOCUMENT_FORMAT),
  encryptedKey: z.string().max(TEXT_LIMITS.encryptedKey).nullable(),
  keySavedAt: z.string().max(TEXT_LIMITS.savedAt).nullable(),
  recognitionConcurrency: concurrencySchema,
  revision: z.number().int().nonnegative(),
});
export type SettingsDocument = z.infer<typeof documentSchema>;
/**
 * AI 设置库（配置目录下的 ai/settings.sqlite）：一行 JSON。旧版本的库打开时删掉重建（server/core/versioned-sqlite.ts）。
 * 第 2 版起只放 DOCUMENT_FORMAT 格式的文档；0.8.4 记的是第 1 版（多套预设），打开时按统一规则重建。
 */
const settingsDatabase = {
  label: 'AI 设置库',
  latest: 2,
  pragmas: 'PRAGMA synchronous=FULL; PRAGMA secure_delete=ON',
  create(db: DatabaseSync) {
    db.exec('CREATE TABLE ai_settings(id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL)');
  },
};
const documentRow = rows.ai_settings.pick({ document: true });
// 默认位置登记进配置库登记表：恢复备份时据此认出备份 _extra 里的那一份是 AI 设置库、支持到第几版
registerVersionedSqlite(settingsDatabase, defaultAiSettingsPath);

export class SettingsRepository {
  private db: DatabaseSync;
  constructor(readonly file = defaultAiSettingsPath()) {
    this.db = openVersionedSqlite(file, settingsDatabase);
  }
  /** 读出文档并按结构核对；还没存过是 null，不合结构抛 StoredDataError。 */
  load(): SettingsDocument | null {
    const row = one(this.db, documentRow, 'SELECT document FROM ai_settings WHERE id=1');
    return row ? parseStoredJson(documentSchema, row.document, 'ai_settings.document') : null;
  }
  save(document: SettingsDocument, expectedRevision?: number) {
    const checked = documentSchema.parse(document);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.load();
      if (expectedRevision !== undefined && current && current.revision !== expectedRevision)
        throw new ConflictError();
      this.db
        .prepare(
          'INSERT INTO ai_settings(id,document) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document',
        )
        .run(JSON.stringify(checked));
      this.db.exec('COMMIT');
    } catch (error) {
      // 磁盘满、读写出错时 SQLite 已经自己退回了，再退一次会报错，盖住原来的原因
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
