import { z } from 'zod';
import type { Store } from '../../core/index.js';
import { many, rows } from '../../core/index.js';
import { flowEntityPrefix, flowStatus, type FlowKind } from '../../../shared/business/index.js';

/*
 * 单据流转的轻量只读：按编号或条件只取几列（版本号、单号、原件文件名），不组装单据视图。
 * 给上层核对“数据变没变”（助手确认卡片的数据版本）、列表补名字用；要单据的样子读 FlowService 的 list、get。
 */

const PRODUCTION: FlowKind = 'production',
  ARRIVAL: FlowKind = 'arrival';
const numberedVersion =z.object({ id: z.number(), version: z.number(), archived: z.number(), number: z.string() });
/** 单据的版本号、单号和归档标记（归档按 flowEntity(种类) 记） */
const versionSelect = `SELECT t.id,t.version,t.number,EXISTS(SELECT 1 FROM record_lifecycle a WHERE a.entity='${flowEntityPrefix}'||t.kind AND a.record_id=t.id) AS archived FROM flow_documents t`;

/** 单据的版本号（含归档的），按编号排；不给种类就是全部 */
export const documentVersions = (store: Store, kind?: FlowKind) =>
  many(store.db, numberedVersion, versionSelect + (kind ? ' WHERE t.kind=?' : '') + ' ORDER BY t.id', ...(kind ? [kind] : []));

/**
 * 待入库的完工单的版本号：登记时不动生产任务的版本号（核对入库时才动），
 * 要看“出卡片以后有没有人按这张任务登记了完工”的，连它们一起核对。
 */
export const pendingCompletionVersions = (store: Store) =>
  many(store.db, numberedVersion, versionSelect + ' WHERE t.kind=? AND t.status=? ORDER BY t.id', PRODUCTION, flowStatus.draft);

const arrivalHead = rows.flow_documents.pick({ id: true, number: true, status: true });
/**
 * 到货单（含归档的）的单号、状态和锁没锁（已确认、取消、撤销的不能再改），按编号批量取：
 * 识别导入的文件列表、换识别类型前看锁没锁用。找不到的不在结果里。
 */
export function arrivalHeads(store: Store, ids: readonly number[]) {
  const found = ids.length
    ? many(
        store.db,
        arrivalHead,
        'SELECT id,number,status FROM flow_documents WHERE kind=? AND id IN (SELECT value FROM json_each(?))',
        ARRIVAL,
        JSON.stringify(ids),
      )
    : [];
  return new Map(found.map((r) => [r.id, { number: r.number, status: r.status, locked: r.status !== flowStatus.draft }]));
}

/** 识别原件的文件名：原件编号 → 文件名 */
export function sourceFileNames(store: Store, ids: readonly string[]) {
  if (!ids.length) return new Map<string, string>();
  const found = many(
    store.db,
    rows.flow_sources.pick({ id: true, file_name: true }),
    'SELECT id,file_name FROM flow_sources WHERE id IN (SELECT value FROM json_each(?))',
    JSON.stringify(ids),
  );
  return new Map(found.map((s) => [s.id, s.file_name]));
}
