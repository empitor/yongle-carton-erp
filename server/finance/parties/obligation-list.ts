/**
 * 应收应付的逐笔列表：每笔往来的来源单据号、已核销、开票、余额、到期天数，红字冲销的两笔成对排在一起
 * 并带上另一笔的日期、金额、单据号（见 reversal-pairs.ts）。FinanceParties.obligations 查权限、读参数后调这里。
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { redReleasedByObligation } from '../cash/red-invoices.js';
import { clampPage, count, many, rows } from '../../core/index.js';
import {
  activeReversals,
  chainCtes,
  chainRoot,
  isRerecorded,
  isReversed,
  reversalState,
  reversedCents,
} from '../base/reversal-pairs.js';
import { allocationSum, latestSourceVoucher, voucherColumns } from './obligation-sql.js';

/** 往来来源单据的号：送货单号、到货单号（没有单号的取对方单号）；手工记的往来没有。 */
const sourceNumber = (o: string) => `(SELECT e.source_number FROM fin_events e WHERE e.id=${o}.event_id)`;

/**
 * 没有来源单据的往来是哪一种：期初往来（opening）、压款利息（interest，凭证由利息功能生成）；
 * 别的（手工新建的应收应付）是 null。逐笔的“单据”一栏据此写“期初往来”“压款利息 11-30 0.10”，不笼统写“手工”。
 * 要和 fin_vouchers 以 v 为别名连接着用。
 */
const recordKind = `CASE WHEN o.opening_id IS NOT NULL THEN 'opening' WHEN v.module_source='interest' THEN 'interest' END`;

const obligation = rows.fin_obligations.shape;
/** 逐笔一行：往来整行加上凭证状态、来源单据号、坏账凭证三列、冲销关系、余额、到期天数、已开票 */
const listRow = rows.fin_obligations.extend({
  voucher_status: z.string().nullable(),
  source_number: z.string().nullable(),
  record_kind: z.enum(['opening', 'interest']).nullable(),
  allocated: z.number(),
  bad_debt_voucher_id: z.number().nullable(),
  bad_debt_voucher_status: z.string().nullable(),
  bad_debt_voucher_state: z.string().nullable(),
  reversal_state: z.enum(['reversal', 'reversed']).nullable(),
  rerecorded: z.number(),
  pair_group: z.number(),
  balance: z.number(),
  days_to_due: z.number().nullable(),
  invoiced: z.number(),
});
type ListRow = z.output<typeof listRow>;
/** 冲销成对的另一笔 */
type Pair = {
  pair_id: number;
  pair_date: string;
  pair_amount_cents: number;
  pair_source_number: string | null;
  pair_rerecorded: 0 | 1;
};

export function obligationList(
  db: DatabaseSync,
  input: { kind: string; partyId?: string },
  paging: { page?: number; pageSize: number },
) {
  const { page: requested, pageSize } = paging;
  const args = [input.kind, input.partyId ?? null, input.partyId ?? null];
  const where = `FROM fin_obligations o LEFT JOIN fin_vouchers v ON v.id=o.voucher_id
    WHERE o.kind=? AND (? IS NULL OR o.party_id=?) AND o.tax_status<>'superseded' AND (o.voucher_id IS NULL OR v.status<>'void')`;
  const total = count(db, 'SELECT count(*) ' + where, ...args);
  const page = clampPage(requested ?? 1, pageSize, total);
  // 已开票只算确认过的发票，待确认和作废不算，红票冲掉的部分要扣回，和发票页口径一致。
  // 红字冲销的两笔成对看（见 reversal-pairs.ts）：冲销那笔余额记 0，原往来记两笔的合计余额，
  // 各行余额加起来和以前一样，仍和总账往来科目对得上。
  const list = many(
    db,
    listRow,
    `WITH RECURSIVE ${chainCtes()}
        SELECT o.*,v.status AS voucher_status,${sourceNumber('o')} AS source_number,${recordKind} AS record_kind,${allocationSum('a.obligation_id=o.id')} AS allocated,
          ${voucherColumns(latestSourceVoucher('bad_debt', 'o.id'), 'bad_debt_')},
          ${reversalState('o')} AS reversal_state,${isRerecorded('o')} AS rerecorded,${chainRoot('o')} AS pair_group,
          CASE WHEN o.reversal_of IS NOT NULL THEN 0
            ELSE o.amount_cents-${allocationSum('a.obligation_id=o.id')}+${reversedCents('o')}
              -${allocationSum('a.obligation_id IN (' + activeReversals('o') + ')')} END AS balance,
          CASE WHEN o.reversal_of IS NULL AND NOT ${isReversed('o')}
            THEN CAST(julianday(o.due_date)-julianday(date('now','+8 hours')) AS INTEGER) END AS days_to_due,
          coalesce((SELECT sum(l.amount_cents) FROM fin_invoice_links l JOIN fin_invoices i ON i.id=l.invoice_id
            WHERE l.obligation_id=o.id AND i.status NOT IN ('draft','void')),0) AS invoiced ` +
      where +
      // 同一条冲销链（原来那笔、红字冲销、重记，再冲销、再重记……）排在一起：按链头的日期、编号排，链里按先后
      ` ORDER BY (SELECT x.date FROM fin_obligations x WHERE x.id=pair_group) DESC,pair_group DESC,o.id LIMIT ? OFFSET ?`,
    input.kind,
    ...args,
    pageSize,
    (page - 1) * pageSize,
  );
  const released = redReleasedByObligation(db, list.map((r) => r.id));
  const pairs = reversalPairs(db, list);
  return {
    rows: list.map((r) => ({
      ...r,
      invoiced: r.invoiced - (released.get(r.id) || 0),
      ...pairs.get(r.id),
    })),
    filteredRecords: total,
    page,
    pageSize,
  };
}

const reversalRow = z.object({
  id: obligation.id,
  reversal_of: z.number(),
  date: obligation.date,
  amount_cents: obligation.amount_cents,
});
const originalRow = rows.fin_obligations
  .pick({ id: true, date: true, amount_cents: true })
  .extend({ source_number: z.string().nullable(), rerecorded: z.number() });

/**
 * 红字冲销成对的另一笔：原往来带上冲销那笔的日期、金额，冲销那笔带上原往来的单据号、日期、金额，
 * 界面写“冲的是哪张单据的哪笔”。整页一次查，对方不在这一页也能查到。
 */
function reversalPairs(db: DatabaseSync, list: readonly ListRow[]) {
  const out = new Map<number, Pair>();
  const reversed = list.filter((r) => r.reversal_state === 'reversed').map((r) => r.id);
  const reversals = list.filter((r) => r.reversal_state === 'reversal');
  if (!reversed.length && !reversals.length) return out;
  for (const r of many(
    db,
    reversalRow,
    `SELECT r.id,r.reversal_of,r.date,r.amount_cents FROM fin_obligations r JOIN fin_vouchers rv ON rv.id=r.voucher_id
      WHERE rv.status<>'void' AND r.reversal_of IN (SELECT value FROM json_each(?)) ORDER BY r.id`,
    JSON.stringify(reversed),
  ))
    out.set(r.reversal_of, {
      pair_id: r.id,
      pair_date: r.date,
      pair_amount_cents: r.amount_cents,
      pair_source_number: null,
      pair_rerecorded: 0,
    });
  const originals = new Map(
    many(
      db,
      originalRow,
      `SELECT o.id,o.date,o.amount_cents,${sourceNumber('o')} AS source_number,${isRerecorded('o')} AS rerecorded FROM fin_obligations o
        WHERE o.id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(reversals.map((r) => r.reversal_of)),
    ).map((o) => [o.id, o]),
  );
  for (const r of reversals) {
    const o = r.reversal_of === null ? undefined : originals.get(r.reversal_of);
    if (o)
      out.set(r.id, {
        pair_id: o.id,
        pair_date: o.date,
        pair_amount_cents: o.amount_cents,
        pair_source_number: o.source_number ?? null,
        // 多层时冲的可能是上一次重记的那笔，界面写“冲的是 … 重记的那笔”，不叫原单
        pair_rerecorded: o.rerecorded ? 1 : 0,
      });
  }
  return out;
}
