import type { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { defaultDbPath, one, openVersionedSqlite, parseStoredJson, registerVersionedSqlite, rows } from '../core/index.js';
import { randomUUID, createHash } from 'node:crypto';
import {
  promptModules,
  promptRevisionSchema,
  promptSaveSchema,
  promptStateSchema,
  promptTargetSchema,
  type PromptAction,
  type PromptPreset,
  type PromptState,
} from '../../shared/ai/index.js';
import { forgetEdited, initialPromptState, refreshDefaults, restoreDefault } from './prompt-defaults.js';
import { AppError } from '../core/index.js';

export const defaultPromptSettingsPath = () =>
  join(dirname(defaultDbPath), 'ai-prompts', 'presets.sqlite');
/** 复制时名字留前 75 个字再接“ 副本”，不超过名称上限 80 字 */
const COPY_NAME_CHARS = 75;
/** 整份提示词配置最多 2 MB */
const MAX_DOCUMENT_BYTES = 2_097_152;
const documentRow = rows.prompt_settings.pick({ document: true });
/** 当前用的那份预设：结构核对过当前预设一定在，找不到说明程序有错 */
function activePreset(state: PromptState): PromptPreset {
  const preset = state.presets.find((p) => p.id === state.activeId);
  if (!preset) throw new Error('提示词配置里找不到当前预设');
  return preset;
}
/**
 * 提示词库（ai-prompts 下每个模块一个文件）：prompt_settings 一行 JSON，用 PRAGMA user_version 记结构版本。
 * 基线是 0.9.0 的第 2 版：比它旧的（0.8.4 留下的）打开时删掉、按当前默认重建；以后改结构在 steps 加一步，改过的提示词留着；
 * 比程序新的拒绝打开（规矩见 server/core/backup/versioned-sqlite-spec.ts 开头）。
 * 默认文字变了不用改版本：没改过的默认在打开时自动换新（prompt-defaults.ts）。
 */
const promptDatabase = {
  label: '提示词库',
  baseline: 2,
  steps: [],
  pragmas: 'PRAGMA synchronous=FULL',
  create(db: DatabaseSync) {
    db.exec(`-- 每个提示词模块一个文件（文件名是 shared/ai/prompt-modules.ts 里各模块的 storageFile）。
      -- 默认文字变了不用升版本，没改过的默认打开时自动换新

      -- 一行 JSON（每个文件各一张）
      CREATE TABLE prompt_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, document TEXT NOT NULL)`);
  },
};
// 每个提示词模块的默认文件都登记进配置库登记表：恢复备份的维护命令行不打开提示词库，
// 靠这一条认出备份里 ai-prompts 下的文件是提示词库、支持到第几版
for (const module of promptModules)
  registerVersionedSqlite(promptDatabase, () => join(dirname(defaultPromptSettingsPath()), module.storageFile));
/**
 * 一个模块的提示词库。默认内容由用它的模块给（defaultPreset：订单、送货单识别的在识别导入，助手的在助手），
 * AI 接入只管存取、跟着默认升级和恢复默认。
 */
export class PromptPresetManager {
  private db: DatabaseSync;
  constructor(
    file: string,
    private defaultPreset: () => PromptPreset,
  ) {
    this.db = openVersionedSqlite(file, promptDatabase);
    const latest = this.defaultPreset();
    this.db
      .prepare('INSERT OR IGNORE INTO prompt_settings(id,revision,document) VALUES(1,0,?)')
      .run(JSON.stringify(initialPromptState(latest)));
    const current = this.view(); // 损坏配置明确报错，不静默清空或覆盖。
    const refreshed = refreshDefaults(current, latest);
    if (refreshed.changed) this.write(refreshed.state, current.revision);
  }
  close() {
    this.db.close();
  }
  view(): PromptState {
    // 设置行在打开时就插好了，读不到说明库被改坏了
    const row = one(this.db, documentRow, 'SELECT document FROM prompt_settings WHERE id=1');
    if (!row) throw new Error('提示词库里没有设置行');
    return parseStoredJson(promptStateSchema, row.document, 'prompt_settings.document');
  }
  snapshot() {
    const state = this.view(),
      preset = activePreset(state);
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
  change(action: PromptAction, raw: unknown): PromptState {
    const expected = promptRevisionSchema.parse(raw).expectedRevision;
    let state = this.view();
    if (state.revision !== expected)
      throw new AppError('提示词预设已在其他页面修改，请重新加载后操作。', 409, 'stale');
    if (action === 'save') {
      const input = promptSaveSchema.parse(raw);
      const index = state.presets.findIndex((p) => p.id === input.preset.id);
      if (index < 0) state.presets.push(input.preset);
      else state.presets[index] = input.preset;
      if (input.activate) state.activeId = input.preset.id;
    } else {
      const input = promptTargetSchema.parse(raw),
        index = state.presets.findIndex((p) => p.id === input.id);
      if (index < 0) throw new AppError('提示词预设不存在。', 404);
      if (action === 'activate') state.activeId = input.id;
      if (action === 'copy') {
        const copy = structuredClone(state.presets[index]);
        copy.id = randomUUID();
        copy.name = copy.name.slice(0, COPY_NAME_CHARS) + ' 副本';
        copy.entries.forEach((e) => (e.id = randomUUID()));
        state.presets.push(copy);
      }
      if (action === 'delete' || action === 'restore') {
        if (input.confirmed !== true) throw new AppError('请确认删除或恢复默认操作。');
        if (action === 'restore') state = restoreDefault(state, input.id, this.defaultPreset());
        else {
          if (state.presets.length === 1) throw new AppError('至少保留一份提示词预设。');
          state.presets.splice(index, 1);
          if (state.activeId === input.id) state.activeId = state.presets[0].id;
        }
      }
    }
    return this.write(state, expected);
  }
  /** 带版本校验写回，版本号加一；改过的、删掉的预设顺手不再跟着默认走。 */
  private write(state: PromptState, expected: number): PromptState {
    const next = { ...forgetEdited(state), revision: expected + 1 };
    const document = JSON.stringify(promptStateSchema.parse(next));
    if (Buffer.byteLength(document) > MAX_DOCUMENT_BYTES)
      throw new AppError('提示词配置超过2MB，请精简条目。', 413);
    const result = this.db
      .prepare('UPDATE prompt_settings SET revision=?,document=? WHERE id=1 AND revision=?')
      .run(next.revision, document, expected);
    if (!result.changes) throw new AppError('提示词保存冲突，请重新加载。', 409, 'stale');
    return this.view();
  }
}
