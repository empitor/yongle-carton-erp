// 只管：长期记忆的读写，按账号分开——每条都带 user_id，每个查询都按 user_id 过滤，别的账号（包括超级管理员）读不到、改不了。
// 表 assistant_memories 在助手设置库（ai-tools/tools.sqlite，建表在 tool-registry.ts），不进业务库：业务数据初始化、清空都不动它。
// 能不能记由 memory-rules.ts 判断；助手的工具在 tools/memory.ts，面板的地址在 memory-router.ts。
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AppError, count, many, one, rows } from '../core/index.js';
import type { AssistantAccountSettings } from './account-settings.js';
import { contentProblem, normalizeMemory } from './memory-rules.js';
import { memoryLimits, memorySources, type MemoryView } from '../../shared/assistant/index.js';

/** assistant：助手在对话里记的；manual：用户在记忆面板里自己加的（和建表的 CHECK 一致）。 */
export type MemorySource = (typeof memorySources)[number];

const columns = 'id,content,source,created_at AS createdAt,updated_at AS updatedAt';
const memoryRow = rows.assistant_memories.pick({ id: true, content: true }).extend({
  source: z.enum(memorySources),
  createdAt: rows.assistant_memories.shape.created_at,
  updatedAt: rows.assistant_memories.shape.updated_at,
});
export type Memory = z.infer<typeof memoryRow>;
/** 按关键字找时最多用几个词 */
const MAX_TERMS = 8;
const autoSaveName = 'memory.autoSave';
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

export class AssistantMemory {
  constructor(
    private readonly db: DatabaseSync,
    private readonly settings: AssistantAccountSettings,
  ) {}
  /** 面板一次要的全部：记忆（新的在前）、自动记忆开没开、上限。 */
  view(userId: string): MemoryView {
    return { memories: this.list(userId), autoSave: this.autoSave(userId), limits: { count: memoryLimits.count, chars: memoryLimits.chars } };
  }
  list(userId: string) {
    return many(this.db, memoryRow, `SELECT ${columns} FROM assistant_memories WHERE user_id=? ORDER BY updated_at DESC, id DESC`, userId);
  }
  /** 按关键字找（空格分开，任一个词对上就算），对上的词多的在前。找到的记一次“用到”，放进上下文时优先。 */
  search(userId: string, query: string, limit = 20) {
    const terms = [...new Set(query.split(/\s+/).filter(Boolean))].slice(0, MAX_TERMS);
    if (!terms.length) return [];
    const matched = many(
      this.db,
      memoryRow,
      `SELECT ${columns} FROM assistant_memories WHERE user_id=? AND (${terms.map(() => "content LIKE ? ESCAPE '\\'").join(' OR ')}) ORDER BY updated_at DESC, id DESC`,
      userId,
      ...terms.map((t) => '%' + likeEscape(t) + '%'),
    );
    const hits = (m: Memory) => terms.filter((t) => m.content.toLowerCase().includes(t.toLowerCase())).length;
    const found = matched.sort((a, b) => hits(b) - hits(a)).slice(0, limit);
    if (found.length)
      this.db
        .prepare(
          `UPDATE assistant_memories SET use_count=use_count+1, used_at=? WHERE user_id=? AND id IN (${found.map(() => '?').join(',')})`,
        )
        .run(new Date().toISOString(), userId, ...found.map((m) => m.id));
    return found;
  }
  /** 存一条。一模一样的已经有了就只更新时间；满了不挤掉旧的，提示到面板整理。 */
  add(userId: string, content: string, source: MemorySource) {
    const text = checked(content);
    const now = new Date().toISOString();
    const same = one(this.db, rows.assistant_memories.pick({ id: true }), 'SELECT id FROM assistant_memories WHERE user_id=? AND content=?', userId, text);
    if (same) {
      this.db.prepare('UPDATE assistant_memories SET updated_at=? WHERE id=?').run(now, same.id);
      return { memory: this.get(userId, same.id), existed: true };
    }
    if (count(this.db, 'SELECT count(*) AS n FROM assistant_memories WHERE user_id=?', userId) >= memoryLimits.count)
      throw new AppError(`记忆已满（每个账号最多 ${memoryLimits.count} 条），没有记。请先在助手窗口“更多 → 记忆”里删掉不要的。`, 409, 'memory-full');
    const id = this.db
      .prepare('INSERT INTO assistant_memories(user_id,content,source,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run(userId, text, source, now, now).lastInsertRowid;
    return { memory: this.get(userId, Number(id)), existed: false };
  }
  update(userId: string, id: number, content: string) {
    const text = checked(content);
    this.get(userId, id);
    this.db.prepare('UPDATE assistant_memories SET content=?, updated_at=? WHERE id=? AND user_id=?').run(text, new Date().toISOString(), id, userId);
    return this.get(userId, id);
  }
  remove(userId: string, id: number) {
    const memory = this.get(userId, id);
    this.db.prepare('DELETE FROM assistant_memories WHERE id=? AND user_id=?').run(id, userId);
    return memory;
  }
  /** 清空这个账号的全部记忆，返回删了几条。自动记忆的开关不动。 */
  clear(userId: string) {
    return Number(this.db.prepare('DELETE FROM assistant_memories WHERE user_id=?').run(userId).changes);
  }
  /**
   * 放进上下文的：最近改过的和最常用到的各取一半，去重，合计不超过上限的条数和字数。
   * 选中的按编号排：只有选中的那几条变了，放进上下文的文字才变（前缀缓存打得中）。
   */
  forContext(userId: string) {
    const half = Math.ceil(memoryLimits.contextItems / 2);
    const recent = many(
      this.db,
      memoryRow,
      `SELECT ${columns} FROM assistant_memories WHERE user_id=? ORDER BY updated_at DESC, id DESC LIMIT ?`,
      userId,
      memoryLimits.contextItems,
    );
    const used = many(
      this.db,
      memoryRow,
      `SELECT ${columns} FROM assistant_memories WHERE user_id=? AND use_count>0 ORDER BY use_count DESC, used_at DESC LIMIT ?`,
      userId,
      half,
    );
    const picked = new Map<number, Memory>();
    for (const m of [...used, ...recent]) if (picked.size < memoryLimits.contextItems) picked.set(m.id, m);
    let chars = 0;
    return [...picked.values()]
      .filter((m) => (chars += m.content.length) <= memoryLimits.contextChars)
      .sort((a, b) => a.id - b.id);
  }
  /** 自动记忆默认开着；关掉后助手不再自己存，已有的照样用。 */
  autoSave(userId: string) {
    return this.settings.get(userId, autoSaveName) !== 'off';
  }
  setAutoSave(userId: string, on: boolean) {
    this.settings.set(userId, autoSaveName, on ? 'on' : 'off');
    return on;
  }
  /** 账号删掉时把它的记忆和设置一起删（现在账号只能停用，没有删除；有了删除时调用这一个）。 */
  forgetAccount(userId: string) {
    this.db.prepare('DELETE FROM assistant_memories WHERE user_id=?').run(userId);
    this.settings.forgetAccount(userId);
  }
  /** 别人的和不存在的一样说“不存在”，不透露别的账号有没有这条。 */
  private get(userId: string, id: number) {
    const row = one(this.db, memoryRow, `SELECT ${columns} FROM assistant_memories WHERE id=? AND user_id=?`, id, userId);
    if (!row) throw new AppError('这条记忆不存在，可能已经删掉了。', 404, 'not-found');
    return row;
  }
}

/** 统一写法（NFKC、去零宽、空白压成一个空格）后再查、再存：存下来的就是查过的那个样子。 */
function checked(content: string) {
  const problem = contentProblem(content);
  if (problem) throw new AppError(problem, 422, 'memory-rejected');
  return normalizeMemory(content);
}
