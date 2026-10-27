import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PublicPreset } from '../../shared/ai-settings.js';
import { defaultAiSettingsPath } from './credential-store.js';

export type StoredPreset = Omit<PublicPreset, 'hasApiKey'> & { encryptedKey: string | null };
export type SettingsDocument = {
  presets: StoredPreset[];
  lastPresetId: string | null;
  autoConnect: boolean;
  recognitionConcurrency?: number;
  revision: number;
};
export class SettingsRepository {
  private db: DatabaseSync;
  constructor(readonly file = defaultAiSettingsPath()) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version > 1) {
      this.db.close();
      throw new Error('unsupported settings version');
    }
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS ai_settings(id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL);`);
    if (version.user_version === 0) this.db.exec('PRAGMA user_version=1');
  }
  load(): SettingsDocument | null {
    const row = this.db.prepare('SELECT document FROM ai_settings WHERE id=1').get() as
      { document: string } | undefined;
    return row ? JSON.parse(row.document) : null;
  }
  save(document: SettingsDocument, expectedRevision?: number) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.load();
      if (expectedRevision !== undefined && current && current.revision !== expectedRevision)
        throw new Error('revision');
      this.db
        .prepare(
          'INSERT INTO ai_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document',
        )
        .run(JSON.stringify(document));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
