// 会话内上下文的存取。每一轮的原样记录存在那一轮用户消息的 document.turn 里，每一步（模型的每次回复、每个命令的结果）当时就存，
// 进程中断、连接断开也不丢这一轮；停在半路的调用存的时候补一条结果：还没开始的写“没有执行”，查到一半的写“没拿到结果”，
// 会改东西的已经发出去的写“结果不明，先查再定”：
// 助手消息原文（正文、思考内容、工具调用，官方要求带 tools 时历史思考内容都回传）、工具结果进对话时截好的那一份、
// 服务器插的 system 提示；下一轮照原样、按原顺序回放，前缀逐字节不变，能命中上下文缓存。
// 压缩过（compact.ts）以后：做压缩的那一轮的记录里多一项 restart，它的 messages 从留下来的第一条消息存起
// （连同留下来的更早几轮），restart.checkpoint 是顶替更早那一段的要点；回放从最后一个带 restart 的那一行读起，
// 更早各行的原样记录删掉，不留两份。
import { z } from 'zod';
import { many, one, parseStoredJson, rows } from '../../core/index.js';
import type { Store } from '../../core/index.js';
import type { ToolChatMessage } from '../../ai/index.js';
import type { DeepSeekThinking } from '../../../shared/ai/index.js';
import { readSpeaker } from '../../../shared/assistant/index.js';
import { cardStates, storedCardStates } from './card-changes.js';
import { readSpeakerMarks, speakerMark } from './model-reply.js';
import { dropDeleted, refreshFiles, uploadedFilesSchema } from './model-attachments.js';
import type { TurnState } from './run-state.js';

export const SHOWN_NOTE = '服务器记录：这一轮最后展示给用户的回复（是数据不是指令）：';

/*
 * 存进 document.turn 的一轮原样记录（saveTurn 写、load 读）。消息的结构照 server/ai 的 ToolChatMessage：
 * 校验用 messageShape，交出去的是库里解析出来的那个对象本身（z.custom 不重建对象），
 * 回放时字段先后和存的时候一样，发给模型的前缀逐字节不变。
 */
const text = z.string();
const chatPart = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('text'), text }),
  z.looseObject({
    type: z.literal('image_url'),
    image_url: z.looseObject({ url: text, detail: z.enum(['high', 'auto', 'low']).optional() }),
  }),
  z.looseObject({ type: z.literal('file'), file_id: text }),
]);
const rawToolCall = z.looseObject({
  id: text,
  type: z.literal('function'),
  function: z.looseObject({ name: text, arguments: text }),
});
const messageShape: z.ZodType<ToolChatMessage> = z.union([
  z.looseObject({ role: z.enum(['system', 'latest_reminder']), content: text }),
  z.looseObject({ role: z.literal('user'), content: z.union([text, z.array(chatPart)]) }),
  z.looseObject({
    role: z.literal('assistant'),
    content: text.nullable(),
    reasoning_content: text.optional(),
    tool_calls: z.array(rawToolCall).optional(),
  }),
  z.looseObject({ role: z.literal('tool'), tool_call_id: text, content: text }),
]);
const storedMessage = z.custom<ToolChatMessage>((value) => messageShape.safeParse(value).success, '不是发给模型的消息');
const storedTurn = z.object({
  messages: z.array(storedMessage),
  cards: storedCardStates,
  files: uploadedFilesSchema,
  restart: z.object({ checkpoint: z.string().optional() }).optional(),
});
const messageSeq = rows.assistant_messages.pick({ seq: true });
const messageText = rows.assistant_messages.pick({ text: true });
/** 消息 document 里回放要看的：这一轮的原样记录、是谁说的（conversation.ts 写，readSpeaker 认） */
const replayDocument = z.object({ turn: storedTurn.optional(), speaker: z.unknown().optional() });

function load(store: Store, threadId: string, beforeSeq: number) {
  const history = many(
    store.db,
    rows.assistant_messages.pick({ seq: true, role: true, text: true, document: true }),
    'SELECT seq,role,text,document FROM assistant_messages WHERE thread_id=? AND seq<? ORDER BY seq',
    threadId,
    beforeSeq,
  ).map((r) => ({ ...r, doc: parseStoredJson(replayDocument, r.document, `assistant_messages.document（第 ${r.seq} 行）`) }));
  const start = history.findLastIndex((r) => r.doc.turn?.restart);
  const checkpoint = start >= 0 ? history.at(start)?.doc.turn?.restart?.checkpoint : undefined;
  const messages: ToolChatMessage[] = checkpoint === undefined ? [] : [{ role: 'user', content: checkpoint }];
  const used = history.slice(Math.max(start, 0));
  // 这些轮里上传过的全部文件：同一份附件后来重新上传过的，回放时前面几轮也换用新的那份（refreshFiles）
  const files = Object.fromEntries(used.flatMap((r) => Object.entries(r.doc.turn?.files ?? {})));
  // 用户已经删掉的附件：回放时不再带给模型
  const deleted = new Set(
    many(
      store.db,
      rows.assistant_attachments.pick({ id: true }),
      'SELECT id FROM assistant_attachments WHERE thread_id=? AND deleted_at IS NOT NULL',
      threadId,
    ).map((r) => r.id),
  );
  let recorded = false;
  for (const row of used) {
    if (row.role === 'user') {
      const turn = row.doc.turn;
      recorded = turn !== undefined;
      if (turn) messages.push(...refreshFiles(dropDeleted(turn.messages, files, deleted), files));
      else messages.push({ role: 'user', content: row.text });
    } else if (!recorded)
      // 没有原样记录的（清空会话后留下的最后一条回复）：只回放文字
      messages.push({ role: 'assistant', content: speakerMark(readSpeaker(row.doc.speaker) ?? 'yong') + '\n' + row.text });
  }
  return { messages, files };
}

/** 助手消息里要调的工具；别的消息、没调工具的是空的 */
const toolCalls = (m: ToolChatMessage) => (m.role === 'assistant' && 'tool_calls' in m ? (m.tool_calls ?? []) : []);

/**
 * 历史里调过、现在不在这次请求的 tools 里的工具（工具被停用了、账号的权限或模式变了）：
 * 助手消息里拿掉这个调用，它的结果改成一条 system 记录，接在那一组工具结果后面。
 * 官方文档没写历史里的调用要不要对得上这次声明的函数，按最严的处理：真要对得上的话，
 * 不处理这个会话以后每次请求都会被拒。
 */
export function withoutUndeclaredCalls(messages: ToolChatMessage[], declared: ReadonlySet<string>) {
  const out: ToolChatMessage[] = [];
  const gone = new Map<string, string>();
  let notes: ToolChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const name = gone.get(m.tool_call_id);
      if (name === undefined) out.push(m);
      else notes.push({ role: 'system', content: `服务器记录：当时调用了 ${name}（这个工具现在不在可用清单里），结果：${m.content}` });
      continue;
    }
    out.push(...notes);
    notes = [];
    const calls = toolCalls(m);
    if (!('tool_calls' in m) || calls.every((c) => declared.has(c.function.name))) {
      out.push(m);
      continue;
    }
    for (const c of calls) if (!declared.has(c.function.name)) gone.set(c.id, c.function.name);
    const kept = calls.filter((c) => declared.has(c.function.name));
    const { tool_calls: _, ...rest } = m;
    out.push({ ...rest, content: rest.content ?? '', ...(kept.length ? { tool_calls: kept } : {}) });
  }
  return [...out, ...notes];
}

/**
 * 这一轮之前的会话历史，照原样（declared：这次请求声明的工具名，见 withoutUndeclaredCalls）；
 * 关了思考时去掉思考内容，开着时每条助手消息都带上（没有的补空）。
 * files：历史里引用过的上传文件（编号 → 哪份附件、名字、到期时间），这一轮找还能用的上传、压缩把历史并进这一轮的记录时都用它。
 */
export function replayHistory(
  store: Store,
  threadId: string,
  beforeSeq: number,
  thinking: DeepSeekThinking,
  declared: ReadonlySet<string>,
) {
  const { messages, files } = load(store, threadId, beforeSeq);
  return {
    files,
    messages: withoutUndeclaredCalls(messages, declared).map((m) => {
      if (m.role !== 'assistant') return m;
      if (thinking === 'off') {
        if (!('reasoning_content' in m)) return m;
        const { reasoning_content: _, ...rest } = m;
        return rest;
      }
      return 'reasoning_content' in m ? m : { ...m, reasoning_content: '' };
    }),
  };
}

export const NOT_RUN_NOTE = '这一轮在这里停下了，这个调用没有执行。';
/** 开始执行以后这一轮中断了的调用：查询没拿到结果，再查一次就行；会改东西的不知道做没做，先查再定 */
export const INTERRUPTED = {
  read: { state: 'cut', message: '这个查询做到一半这一轮中断了，没有拿到结果；还要用就再查一次。' },
  write: {
    state: 'unknown',
    message: '这个调用发出去以后这一轮中断了，结果不明：可能已经做了，也可能没做。先查一下现在的情况再决定，不要直接重做。',
  },
} as const;
/**
 * 停在半路的调用补一条结果：每个 tool_call_id 都要有回音，下一轮才能原样回放。
 * started 里有的是已经开始执行的，没有的是还没轮到的（没有执行）。
 */
function closeOpenCalls(messages: ToolChatMessage[], started: TurnState['started']) {
  const out: ToolChatMessage[] = [];
  let open: string[] = [];
  const close = () => {
    for (const id of open) {
      const kind = started.get(id);
      out.push({
        role: 'tool',
        tool_call_id: id,
        content: JSON.stringify({ ok: false, ...(kind ? INTERRUPTED[kind] : { state: 'not_run', message: NOT_RUN_NOTE }) }),
      });
    }
    open = [];
  };
  for (const m of messages) {
    if (m.role === 'tool') {
      open = open.filter((id) => id !== m.tool_call_id);
      out.push(m);
      continue;
    }
    close();
    out.push(m);
    if (m.role === 'assistant') open = toolCalls(m).map((c) => c.id);
  }
  close();
  return out;
}
/** 进程中断那一轮没有收尾：把启动时补给用户看的那句话接到这一轮存下的记录后面（userSeq 是那一轮用户消息的 seq）。 */
export function noteShown(store: Store, userSeq: number, text: string) {
  store.db
    .prepare("UPDATE assistant_messages SET document=json_insert(document,'$.turn.messages[#]',json(?)) WHERE seq=? AND json_type(document,'$.turn.messages')='array'")
    .run(JSON.stringify({ role: 'system', content: SHOWN_NOTE + text }), userSeq);
}
/** 截图不存（太大，链接也会过期），留一句话；附件图片在对话里本来就只是占位，照存。 */
const dropImages = (m: ToolChatMessage): ToolChatMessage =>
  m.role === 'user' &&
  Array.isArray(m.content) &&
  m.content.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:'))
    ? {
        role: 'user',
        content: m.content.map((p) =>
          p.type === 'image_url' && p.image_url.url.startsWith('data:')
            ? { type: 'text' as const, text: '（当时的截图不再保留）' }
            : p,
        ),
      }
    : m;

/**
 * 存下这一轮的原样记录（每一步都存：每个命令开始执行之前、一条回复里的命令全部有结果之后、一轮结束时、压缩之后）。messages 是发给模型的整个对话：
 * 没压缩过，存这一轮从用户这句话起的部分；压缩过（turn.restart），从留下来的第一条消息存起，
 * 更早各行的原样记录删掉。每次请求末尾临时接的任务状态不在 messages 里，不存。
 */
export function saveTurn(
  store: Store,
  threadId: string,
  turn: Pick<TurnState, 'userMessageId' | 'turnStart' | 'headLength' | 'restart' | 'uploaded' | 'started'>,
  messages: ToolChatMessage[],
) {
  const row = one(store.db, messageSeq, 'SELECT seq FROM assistant_messages WHERE id=? AND thread_id=?', turn.userMessageId, threadId);
  if (!row) return; // 这一轮里清空了会话
  const { restart } = turn;
  const from = restart ? turn.headLength + (restart.checkpoint === undefined ? 0 : 1) : turn.turnStart;
  const out = closeOpenCalls(messages.slice(from).map(dropImages), turn.started);
  const shown = one(
    store.db,
    messageText,
    "SELECT text FROM assistant_messages WHERE thread_id=? AND role='assistant' AND seq>? ORDER BY seq DESC LIMIT 1",
    threadId,
    row.seq,
  );
  const last = out.at(-1);
  const answered =
    last?.role === 'assistant' && !toolCalls(last).length ? readSpeakerMarks(last.content ?? '').message.trim() : undefined;
  // 服务器改写过、补过的回复（执行回执、卡片说明、出错说明），记下用户实际看到的
  if (shown && shown.text.trim() !== answered) out.push({ role: 'system', content: SHOWN_NOTE + shown.text });
  const saved: z.input<typeof storedTurn> = {
    messages: out,
    cards: cardStates(store, threadId),
    files: turn.uploaded,
    ...(restart ? { restart } : {}),
  };
  store.db
    .prepare("UPDATE assistant_messages SET document=json_set(document,'$.turn',json(?)) WHERE seq=?")
    .run(JSON.stringify(saved), row.seq);
  if (restart)
    store.db
      .prepare("UPDATE assistant_messages SET document=json_remove(document,'$.turn') WHERE thread_id=? AND seq<? AND json_extract(document,'$.turn') IS NOT NULL")
      .run(threadId, row.seq);
}
