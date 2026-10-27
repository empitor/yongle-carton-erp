import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import {
  promptStateSchema,
  promptPresetSchema,
  type PromptState,
} from '../../shared/prompt-presets.js';
import { defaultPromptPreset } from '../import/default-prompts.js';
import { ImportError } from '../import/errors.js';

export const defaultPromptSettingsPath = () =>
  fileURLToPath(new URL('../../data/ai-prompts/presets.sqlite', import.meta.url));
const revision = z.object({ expectedRevision: z.number().int().nonnegative() });
export class PromptPresetManager {
  private db: DatabaseSync;
  constructor(
    file = ':memory:',
    private defaultPreset = defaultPromptPreset,
  ) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(
      'PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS prompt_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, document TEXT NOT NULL)',
    );
    const preset = this.defaultPreset(),
      initial: PromptState = { revision: 0, activeId: preset.id, presets: [preset] };
    this.db
      .prepare('INSERT OR IGNORE INTO prompt_settings VALUES(1,0,?)')
      .run(JSON.stringify(initial));
    this.view(); // 损坏配置明确报错，不静默清空或覆盖。
  }
  close() {
    this.db.close();
  }
  upgradeUntouchedDefaults(legacy: ReturnType<typeof defaultPromptPreset>[], version: string) {
    const canonical = (p: ReturnType<typeof defaultPromptPreset>) =>
      JSON.stringify({
        name: p.name,
        entries: p.entries.map(({ name, enabled, content }) => ({ name, enabled, content })),
      });
    const signatures = new Set(legacy.map(canonical));
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS prompt_default_upgrades(version TEXT PRIMARY KEY,applied_at TEXT NOT NULL,document TEXT NOT NULL)',
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT 1 FROM prompt_default_upgrades WHERE version=?').get(version)) {
        this.db.exec('COMMIT');
        return;
      }
      const state = this.view(),
        before = structuredClone(state),
        latest = this.defaultPreset();
      let count = 0;
      for (const p of state.presets)
        if (signatures.has(canonical(p))) {
          p.entries = latest.entries.map((e, i) => ({ ...e, id: p.entries[i]?.id || e.id }));
          count++;
        }
      if (count) {
        state.revision++;
        const document = JSON.stringify(promptStateSchema.parse(state));
        this.db
          .prepare('UPDATE prompt_settings SET revision=?,document=? WHERE id=1')
          .run(state.revision, document);
      }
      this.db
        .prepare('INSERT INTO prompt_default_upgrades VALUES(?,?,?)')
        .run(version, new Date().toISOString(), JSON.stringify({ count, before, after: state }));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  view(): PromptState {
    const row = this.db.prepare('SELECT document FROM prompt_settings WHERE id=1').get()!;
    return promptStateSchema.parse(JSON.parse(String(row.document)));
  }
  snapshot() {
    const state = this.view(),
      preset = state.presets.find((p) => p.id === state.activeId)!;
    return {
      preset,
      usage: {
        id: preset.id,
        name: preset.name,
        revision: state.revision,
        hash: createHash('sha256').update(JSON.stringify(preset)).digest('hex'),
      },
    };
  }
  change(action: 'save' | 'copy' | 'activate' | 'delete' | 'restore', raw: unknown): PromptState {
    const expected = revision.parse(raw).expectedRevision,
      state = this.view();
    if (state.revision !== expected)
      throw new ImportError('提示词预设已在其他页面修改，请重新加载后操作。', 409, 'stale');
    if (action === 'save') {
      const input = revision
        .extend({ preset: promptPresetSchema, activate: z.boolean().default(false) })
        .strict()
        .parse(raw);
      const index = state.presets.findIndex((p) => p.id === input.preset.id);
      if (index < 0) state.presets.push(input.preset);
      else state.presets[index] = input.preset;
      if (input.activate) state.activeId = input.preset.id;
    } else {
      const input = revision
          .extend({ id: z.string().uuid(), confirmed: z.boolean().optional() })
          .strict()
          .parse(raw),
        index = state.presets.findIndex((p) => p.id === input.id);
      if (index < 0) throw new ImportError('提示词预设不存在。', 404);
      if (action === 'activate') state.activeId = input.id;
      if (action === 'copy') {
        const copy = structuredClone(state.presets[index]);
        copy.id = randomUUID();
        copy.name = copy.name.slice(0, 75) + ' 副本';
        copy.entries.forEach((e) => (e.id = randomUUID()));
        state.presets.push(copy);
      }
      if (action === 'delete' || action === 'restore') {
        if (input.confirmed !== true) throw new ImportError('请确认删除或恢复默认操作。');
        if (action === 'restore') state.presets[index].entries = this.defaultPreset().entries;
        else {
          if (state.presets.length === 1) throw new ImportError('至少保留一份提示词预设。');
          state.presets.splice(index, 1);
          if (state.activeId === input.id) state.activeId = state.presets[0].id;
        }
      }
    }
    state.revision = expected + 1;
    const document = JSON.stringify(promptStateSchema.parse(state));
    if (Buffer.byteLength(document) > 2 * 1024 * 1024)
      throw new ImportError('提示词配置超过2MB，请精简条目。', 413);
    const result = this.db
      .prepare('UPDATE prompt_settings SET revision=?,document=? WHERE id=1 AND revision=?')
      .run(state.revision, document, expected);
    if (!result.changes) throw new ImportError('提示词保存冲突，请重新加载。', 409, 'stale');
    return this.view();
  }
}
