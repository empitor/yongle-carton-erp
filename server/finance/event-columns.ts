/**
 * 财务事件的快照和从快照取出来的查询列：往来单位（种类、编号、名称）、单号、理论金额（含税）、缺不缺税率。
 * 这几列只由 eventColumns 从快照算、只由这里的两个函数和快照在同一句 SQL 里一起写，列就不会和快照对不上；
 * 别的文件的 SQL 不许写 snapshot（tests/finance-event-columns.test.ts 守着），升级步骤（server/core/schema/steps.ts 第 21 步）
 * 回填时按同一个取法。上一条（previous_event_id、previous_status）和单据金额（document_cents）不在快照里，只存在列里。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { z } from 'zod';
import type { rows } from '../core/index.js';
import { documentNumber, snapshotText, type EventSnapshot } from './source-snapshot.js';

type EventRow = z.output<typeof rows.fin_events>;

/** 快照和从它算出来的几列（写库的值；快照是核对过结构的 JSON 文字） */
export function eventColumns(snapshot: EventSnapshot) {
  const doc = snapshot.doc;
  // 送货单只有客户、到货单只有供应商；完工、盘点和启用前的 {} 没有往来单位
  const party =
    doc?.customerId != null
      ? { kind: 'customer', id: String(doc.customerId) }
      : doc?.supplierId != null
        ? { kind: 'supplier', id: String(doc.supplierId) }
        : null;
  return {
    snapshot: snapshotText(snapshot),
    party_kind: party?.kind ?? null,
    party_id: party?.id ?? null,
    party_name: doc?.customerName ?? doc?.supplierName ?? null,
    source_number: documentNumber(doc),
    theoretical_cents: snapshot.theoretical?.gross ?? null,
    missing_tax: snapshot.missing?.includes('tax') ? 1 : 0,
  };
}
export type EventColumns = ReturnType<typeof eventColumns>;

/** 新记一条事件时另给的列：来源、状态和金额，被它接手的上一条（编号和当时的状态），同步时按单据内容算出的金额 */
type NewEvent = Pick<EventRow, 'source_kind' | 'source_id' | 'event_type' | 'source_version' | 'source_hash' | 'date' | 'status'> &
  Partial<Pick<EventRow, 'amount_cents' | 'problem' | 'revenue_recognition' | 'document_cents'>> & {
    previous?: Pick<EventRow, 'id' | 'status'>;
  };

/** 新记一条事件（快照和它的几列一起写），返回编号 */
export function insertEvent(db: DatabaseSync, event: NewEvent, snapshot: EventSnapshot) {
  const c = eventColumns(snapshot);
  return Number(
    db
      .prepare(
        `INSERT INTO fin_events(source_kind,source_id,event_type,source_version,source_hash,date,amount_cents,status,problem,
        revenue_recognition,previous_event_id,previous_status,document_cents,
        snapshot,party_kind,party_id,party_name,source_number,theoretical_cents,missing_tax)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        event.source_kind,
        event.source_id,
        event.event_type,
        event.source_version,
        event.source_hash,
        event.date,
        event.amount_cents ?? null,
        event.status,
        event.problem ?? null,
        event.revenue_recognition ?? null,
        event.previous?.id ?? null,
        event.previous?.status ?? null,
        event.document_cents ?? null,
        c.snapshot,
        c.party_kind,
        c.party_id,
        c.party_name,
        c.source_number,
        c.theoretical_cents,
        c.missing_tax,
      ).lastInsertRowid,
  );
}

/** 换快照时同一句里能一起改的列；没给的不动（上一条一经记下不再改） */
const changeable = ['status', 'problem', 'amount_cents', 'voucher_id', 'source_version', 'source_hash', 'date', 'document_cents'] as const;
type EventChanges = Partial<Pick<EventRow, (typeof changeable)[number]>>;

/** 换一条事件的快照（连同它的几列），同一句里改 changes 给的列，版本号加一 */
export function updateEventSnapshot(db: DatabaseSync, id: number, snapshot: EventSnapshot, changes: EventChanges = {}) {
  const c = eventColumns(snapshot);
  const given = changeable.filter((name) => changes[name] !== undefined);
  db.prepare(
    `UPDATE fin_events SET snapshot=?,party_kind=?,party_id=?,party_name=?,source_number=?,theoretical_cents=?,missing_tax=?,
    ${given.map((name) => name + '=?,').join('')}version=version+1 WHERE id=?`,
  ).run(
    c.snapshot,
    c.party_kind,
    c.party_id,
    c.party_name,
    c.source_number,
    c.theoretical_cents,
    c.missing_tax,
    ...given.map((name) => changes[name] ?? null),
    id,
  );
}
