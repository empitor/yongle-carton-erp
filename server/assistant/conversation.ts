// 聊天会话的记录：核对会话属于当前账号、写消息（带上是小甬还是小勒说的）、写助手操作记录、
// 清空和删除会话、正在回复的会话，以及助手自己查看和删除聊天记录的工具（chat.list、chat.delete）。
// 只碰助手自己的表，不动业务数据。
import { queueRemoteDeletion } from './remote-files.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../core/index.js';
import type { Actor } from '../core/index.js';
import { AppError, exists, inSavepoint, many, one, parseStoredJson, rows } from '../core/index.js';
import { snapshotBeforeDestructive } from '../core/index.js';
import { DEFAULT_SPEAKER, readSpeaker, type AssistantSpeaker } from '../../shared/assistant/index.js';
import { errorMessage } from '../../shared/core/index.js';
import type { AssistantAttachments } from './attachments.js';
import { storedMessageSchema } from '../../shared/assistant/index.js';

/** 消息 document 的结构在 shared/assistant/assistant-views.ts（写入、读出、给页面都按它） */
type MessageDocument = z.input<typeof storedMessageSchema>;

/** 消息是谁说的（assistant_messages.role）、一次运行的状态（assistant_runs.state）能存的全部值，和建表里的 CHECK 一致（tests/schema-constraints.test.ts 比对） */
export const assistantMessageRoles = ['user', 'assistant'] as const;
export const assistantRunStates = ['running', 'completed', 'failed'] as const;
/** chat.list 一次最多列多少个会话；删除结果里最多列多少个标题 */
const MAX_LISTED_THREADS = 200;
const MAX_DELETED_TITLES = 20;
/** 会话清单的一行 */
const listedThread = rows.assistant_threads
  .pick({ id: true, title: true })
  .extend({ updatedAt: rows.assistant_threads.shape.updated_at, messages: z.number() });
type ListedThread = z.infer<typeof listedThread>;
/** chat.delete 要删哪些（模型给的，命令的参数结构见 tools/session.ts）；卡片算定以后存下来、确认时照删的 */
const deletionRequest = z.object({ threadIds: z.array(z.string()).optional(), all: z.boolean().optional(), includeCurrent: z.boolean().optional() });
const threadDeletion = z.object({ threadIds: z.array(z.string()), includeCurrent: z.boolean() });

export class AssistantConversations {
  /** 正在生成回复的会话，和停止它用的开关。 */
  readonly busy = new Map<string, AbortController>();
  constructor(
    private readonly store: Store,
    private readonly attachments: AssistantAttachments,
  ) {}
  thread(id: string, actor: Actor) {
    const r = one(this.store.db, rows.assistant_threads, 'SELECT * FROM assistant_threads WHERE id=? AND user_id=?', z.uuid().parse(id), actor.id);
    if (!r) throw new AppError('聊天不存在或不属于当前账号。', 404);
    return r;
  }
  /** 这个会话里上一次是谁在说话。 */
  lastSpeaker(id: string): AssistantSpeaker {
    const row = one(
      this.store.db,
      rows.assistant_messages.pick({ seq: true, document: true }),
      "SELECT seq,document FROM assistant_messages WHERE thread_id=? AND role='assistant' ORDER BY rowid DESC LIMIT 1",
      id,
    );
    if (!row) return DEFAULT_SPEAKER;
    return readSpeaker(parseStoredJson(storedMessageSchema, row.document, `assistant_messages.document（第 ${row.seq} 行）`).speaker) || DEFAULT_SPEAKER;
  }
  message(id: string, role: (typeof assistantMessageRoles)[number], text: string, document: MessageDocument = {}) {
    if (role === 'assistant' && !readSpeaker(document.speaker)) document = { ...document, speaker: this.lastSpeaker(id) };
    const now = new Date().toISOString();
    const messageId = randomUUID();
    this.store.db
      .prepare('INSERT INTO assistant_messages(id,thread_id,role,text,document,created_at) VALUES(?,?,?,?,?,?)')
      .run(messageId, id, role, text, JSON.stringify(document), now);
    this.store.db.prepare('UPDATE assistant_threads SET updated_at=? WHERE id=?').run(now, id);
    return messageId;
  }
  log(actor: Actor, id: string, tool: string, state: string, document: unknown) {
    this.store.db
      .prepare(
        'INSERT INTO assistant_audit(user_id,thread_id,tool,state,document,created_at) VALUES(?,?,?,?,?,?)',
      )
      .run(actor.id, id, tool, state, JSON.stringify(document), new Date().toISOString());
  }
  /** 清空会话（登录已由调用方核对）。 */
  clear(id: string, actor: Actor) {
    this.thread(id, actor);
    if (this.busy.has(id)) throw new AppError('请先停止正在生成的回复。', 409);
    return inSavepoint(this.store.db, () => {
      this.attachments.clear(id, actor);
      this.store.db
        .prepare(
          "UPDATE assistant_threads SET document=json_remove(document,'$.orderWorkflow','$.webUrls') WHERE id=?",
        )
        .run(id);
      this.store.db.prepare('DELETE FROM assistant_messages WHERE thread_id=?').run(id);
      this.store.db
        .prepare('UPDATE assistant_previews SET expires_at=0 WHERE thread_id=? AND result IS NULL')
        .run(id);
      this.log(actor, id, 'conversation.clear', 'completed', {});
    });
  }
  /** 当前账号的会话清单（chat.list，也给删除卡片取标题用）。 */
  private threads(actor: Actor) {
    return many(
      this.store.db,
      listedThread,
      'SELECT t.id,t.title,t.updated_at AS updatedAt,(SELECT COUNT(*) FROM assistant_messages m WHERE m.thread_id=t.id) AS messages FROM assistant_threads t WHERE t.user_id=? ORDER BY t.updated_at DESC',
      actor.id,
    );
  }
  listThreads(currentId: string, actor: Actor) {
    const rows = this.threads(actor);
    return {
      current: currentId,
      total: rows.length,
      threads: rows.slice(0, MAX_LISTED_THREADS).map((t) => ({ ...t, current: t.id === currentId })),
    };
  }
  /** chat.delete 的确认卡片：把“全部”“指定的几个”“连当前会话”算成确定的会话编号和标题，确认时就删这几个。 */
  deletionTargets(input: unknown, currentId: string, actor: Actor) {
    const raw = deletionRequest.parse(input);
    const rows = this.threads(actor),
      known = new Map(rows.map((t) => [t.id, t]));
    const asked = raw.all ? rows.map((t) => t.id) : raw.threadIds || [];
    const includeCurrent = !!raw.includeCurrent || (!raw.all && asked.includes(currentId));
    const targets = asked.flatMap((t) => {
      const thread = known.get(t);
      return thread && t !== currentId ? [thread] : [];
    });
    if (!targets.length && !includeCurrent)
      throw new AppError(asked.length ? '没有找到要删除的会话。' : '要说明删哪些会话，或者全部删除。', 400);
    return { threadIds: targets.map((t) => t.id), titles: targets.map((t) => t.title), includeCurrent };
  }
  /** 人在卡片上点了确认：删掉这几个会话；includeCurrent 时把当前会话的记录也清空。只碰当前账号自己的会话，不动业务数据。 */
  deleteThreads(input: unknown, currentId: string, actor: Actor) {
    const change = threadDeletion.parse(input);
    const known = new Map(this.threads(actor).map((t) => [t.id, t]));
    const targets = change.threadIds.flatMap((t): ListedThread[] => {
      const thread = known.get(t);
      return thread && t !== currentId ? [thread] : [];
    });
    if (targets.length) snapshotBeforeDestructive(this.store, 'chat-delete');
    const deleted: string[] = [],
      skipped: string[] = [];
    for (const t of targets) {
      if (this.busy.has(t.id)) skipped.push(t.title);
      else {
        this.removeThread(t.id, actor);
        deleted.push(t.title);
      }
    }
    if (change.includeCurrent) this.clear(currentId, actor);
    return {
      deleted: deleted.length,
      titles: deleted.slice(0, MAX_DELETED_TITLES),
      skipped,
      currentCleared: change.includeCurrent,
      message:
        '已删除 ' +
        deleted.length +
        ' 个聊天会话' +
        (change.includeCurrent ? '，当前会话的记录已清空' : '') +
        (skipped.length ? '；' + skipped.length + ' 个正在回复，没有删' : '') +
        '。',
    };
  }
  /** 删除会话（登录已由调用方核对）。 */
  removeThread(id: string, actor: Actor) {
    this.thread(id, actor);
    if (this.busy.has(id)) throw new AppError('请先停止正在生成的回复。', 409);
    inSavepoint(this.store.db, () => {
      // 这个会话传到 DeepSeek 的附件跟着删（remote-files.ts）：消息删掉以后就查不到文件编号了，先记下
      queueRemoteDeletion(this.store, actor.id, id);
      this.store.db
        .prepare(
          'DELETE FROM assistant_message_attachments WHERE message_id IN (SELECT id FROM assistant_messages WHERE thread_id=?)',
        )
        .run(id);
      this.store.db.prepare('DELETE FROM assistant_messages WHERE thread_id=?').run(id);
      this.store.db
        .prepare('DELETE FROM assistant_attachments WHERE thread_id=? AND user_id=?')
        .run(id, actor.id);
      this.store.db.prepare('DELETE FROM assistant_previews WHERE thread_id=?').run(id);
      this.store.db.prepare('DELETE FROM assistant_runs WHERE thread_id=?').run(id);
      this.store.db
        .prepare('DELETE FROM assistant_threads WHERE id=? AND user_id=?')
        .run(id, actor.id);
      if (exists(this.store.db, 'PRAGMA foreign_key_check'))
        throw new AppError('删除会话后仍存在关联引用，已回滚。', 409);
    });
    // 会话删除属于聊天记录清理，正式业务数据不动；审计保留删除事件。
    try {
      this.log(actor, id, 'conversation.delete', 'completed', {});
    } catch (e) {
      // 审计写入失败不影响已提交的会话删除，但要留下痕迹
      console.error('[助手] 删除会话的操作记录没写进去：' + errorMessage(e));
    }
  }
}
