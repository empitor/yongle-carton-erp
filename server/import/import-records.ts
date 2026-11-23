import { sales } from '../sales/index.js';
import { z } from 'zod';
import { many, one, parseStoredJson, rows, type Store } from '../core/index.js';
import type { ImportWorkspaceView } from '../../shared/import/index.js';
import { storedReceipt } from './import-receipt.js';

/**
 * 正式导入的记录（import_executions）：哪份工作区、哪份原件导入过哪张订单，那张订单现在还在不在、归没归档。
 * 只读；写在 import-execution.ts 的执行里。
 */
type ImportedRef = NonNullable<ImportWorkspaceView['imported']>;

const executionRow = rows.import_executions.pick({ id: true, source_id: true, order_id: true, document: true });
const EXECUTION_COLUMNS = 'id,source_id,order_id,document';
/** 列表里只用到回执的订单编号和单号 */
const receiptOrder = storedReceipt.pick({ orderId: true, orderNumber: true });

function refFromRow(store: Store, row: z.infer<typeof executionRow>): ImportedRef {
  const receipt = parseStoredJson(receiptOrder, row.document, `import_executions.document（${row.id}）`);
  const base = {
    executionId: row.id,
    orderId: receipt.orderId,
    orderNumber: receipt.orderNumber,
    sourceId: row.source_id,
  };
  if (row.order_id === null) return { ...base, archived: true, permanentlyDeleted: true };
  const order = sales(store).order(row.order_id, true);
  return order
    ? { ...base, orderId: order.id, orderNumber: order.number, archived: store.archived('orders', order.id) }
    : { ...base, archived: true, permanentlyDeleted: true };
}

/** 这份工作区自己的导入记录（source_id 唯一）。用于不重复导入、导入后只读。 */
export function findOwnImport(store: Store, sourceId: string) {
  const row = one(store.db, executionRow, `SELECT ${EXECUTION_COLUMNS} FROM import_executions WHERE source_id=?`, sourceId);
  return row ? refFromRow(store, row) : undefined;
}

/** 同一原件的全部导入记录，按时间倒序。用于区分有效订单、已归档和已永久删除。 */
export function findFileImports(store: Store, fileHash: string) {
  return many(
    store.db,
    executionRow,
    `SELECT ${EXECUTION_COLUMNS} FROM import_executions WHERE file_hash=? ORDER BY rowid DESC`,
    fileHash,
  ).map((row) => refFromRow(store, row));
}

/**
 * 这份工作区导入过就返回它的记录（historical=false）；没导入过但同一原件以前导入过，
 * 返回最近那次（historical=true），只用于提示“此前处理过”，不阻断识别。
 */
export function findImport(store: Store, id: string, fileHash?: string): ImportWorkspaceView['imported'] {
  const own = findOwnImport(store, id);
  if (own) return own;
  if (!fileHash) return undefined;
  const row = one(
    store.db,
    executionRow,
    `SELECT ${EXECUTION_COLUMNS} FROM import_executions WHERE file_hash=? ORDER BY rowid DESC LIMIT 1`,
    fileHash,
  );
  return row ? { ...refFromRow(store, row), historical: true } : undefined;
}

/** 这个内容指纹以前导入过、而且那张订单还在 */
export function fingerprintImported(store: Store, fingerprint: string) {
  return many(
    store.db,
    z.object({ order_id: z.number() }),
    'SELECT order_id FROM import_executions WHERE fingerprint=? AND order_id IS NOT NULL',
    fingerprint,
  ).some((row) => sales(store).order(row.order_id, true) !== undefined);
}
