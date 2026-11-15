/**
 * 读收件：一行的结构和给页面、助手的视图，列表的筛选、页签数字和分页。
 */
import { z } from 'zod';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { clampPage, count, many, parsePaging, rows } from '../core/index.js';
import {
  convertedKinds,
  inboxChannels,
  inboxFilterSchema,
  inboxKinds,
  inboxStatuses,
  type InboxItem,
  type InboxList,
  type InboxStatus,
} from '../../shared/import/index.js';

/** 收件一行：来源、类型、状态、转成什么按建表的取值收窄 */
export const itemRow = rows.inbox_items.extend({
  channel: z.enum(inboxChannels),
  kind: z.enum(inboxKinds),
  status: z.enum(inboxStatuses),
  converted_kind: z.enum(convertedKinds).nullable(),
});
export const fileRow = rows.inbox_items.pick({ file_name: true, file_mime: true }).extend({ content: rows.inbox_files.shape.content });
const statusCount = z.object({ status: z.enum(inboxStatuses), n: z.number() });

export function itemView(row: z.infer<typeof itemRow>): InboxItem {
  return {
    id: row.id,
    channel: row.channel,
    externalId: row.external_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    conversation: row.conversation,
    kind: row.kind,
    text: row.text,
    fileName: row.file_name,
    fileMime: row.file_mime,
    fileSize: row.file_size,
    fileSha256: row.file_sha256,
    status: row.status,
    convertedKind: row.converted_kind,
    convertedRef: row.converted_ref,
    handledBy: row.handled_by,
    handledAt: row.handled_at,
    version: row.version,
    receivedAt: row.received_at,
    createdAt: row.created_at,
  };
}

const searchFunctions = new WeakSet<DatabaseSync>();
const searchColumns = ['sender_name', 'conversation', 'text', 'file_name'];
// SQLite 内置 lower 只处理 ASCII。关键词和这一格都是 ASCII 时用内置的，否则沿用原列表的 JS 大小写规则。
const unicodeMatch = (column: string) => `instr(inbox_unicode_lower(${column}), inbox_unicode_lower(?)) > 0`;
const asciiMatch = (column: string) => `(CASE
        WHEN octet_length(${column}) = length(${column}) THEN instr(lower(${column}), lower(?))
        ELSE instr(inbox_unicode_lower(${column}), inbox_unicode_lower(?))
      END > 0)`;
/** 来源和关键词的筛选（页签数字也按它数，不管状态）：拼成 WHERE 和参数 */
function inboxScope(f: z.output<typeof inboxFilterSchema>) {
  const clauses: string[] = [],
    params: SQLInputValue[] = [];
  if (f.channel) {
    clauses.push('channel = ?');
    params.push(f.channel);
  }
  if (f.q) {
    const q = f.q,
      ascii = /^[\x01-\x7f]*$/.test(q);
    clauses.push('(' + searchColumns.map(ascii ? asciiMatch : unicodeMatch).join(' OR ') + ')');
    params.push(...searchColumns.flatMap(() => (ascii ? [q, q] : [q])));
  }
  return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : 'WHERE 1=1', params };
}

function registerSearch(db: DatabaseSync) {
  if (searchFunctions.has(db)) return;
  db.function('inbox_unicode_lower', { deterministic: true }, (value) =>
    typeof value === 'string' ? value.toLowerCase() : null,
  );
  searchFunctions.add(db);
}
/** 页签数字不受当前状态筛选影响，来源和关键词仍然生效；返回各状态的条数和当前状态筛出几条 */
function statusCounts(db: DatabaseSync, scope: ReturnType<typeof inboxScope>, status: InboxStatus | undefined) {
  const counts: Record<InboxStatus, number> = { pending: 0, converted: 0, ignored: 0 };
  let filteredRecords = 0;
  const groups = many(db, statusCount, `SELECT status, COUNT(*) AS n FROM inbox_items ${scope.where} GROUP BY status`, ...scope.params);
  for (const group of groups) {
    counts[group.status] = group.n;
    if (!status || status === group.status) filteredRecords += group.n;
  }
  return { counts, filteredRecords };
}
export function listInbox(db: DatabaseSync, filters: z.input<typeof inboxFilterSchema>, query: unknown): InboxList {
  const f = inboxFilterSchema.parse(filters),
    paging = parsePaging(query);
  registerSearch(db);
  const scope = inboxScope(f);
  const totalRecords = count(db, 'SELECT COUNT(*) FROM inbox_items');
  const { counts, filteredRecords } = statusCounts(db, scope, f.status);
  const page = paging.page && clampPage(paging.page, paging.pageSize, filteredRecords);
  // 显式 sort 沿用旧分页比较器；收件记录没有 name、number 或交期字段。
  const sort = page ? paging.sort ?? null : null;
  const order = sort === 'oldest' ? 'id ASC' : sort === null ? 'received_at DESC, id DESC' : 'id DESC';
  const statusClause = f.status ? ' AND status = ?' : '';
  const found = many(
    db,
    itemRow,
    `SELECT * FROM inbox_items ${scope.where}${statusClause} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...scope.params,
    ...(f.status ? [f.status] : []),
    page ? paging.pageSize : -1,
    page ? (page - 1) * paging.pageSize : 0,
  );
  return {
    rows: found.map(itemView), filteredRecords,
    ...(page ? { page, pageSize: paging.pageSize } : {}), totalRecords, counts,
  };
}
