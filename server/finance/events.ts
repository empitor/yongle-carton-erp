import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from '../auth.js';
import type { Store } from '../db.js';
import { dateSchema } from '../../shared/domain.js';
import { purchaseLineAmount } from '../../shared/physical-flow.js';
import { quantityString, quantityUnits } from '../../shared/operations.js';
import {
  accountCodeSchema,
  requestIdSchema,
  versionSchema,
  type FinanceEntry,
} from '../../shared/finance.js';
import { clampPage, parsePaging } from '../paging.js';
import { checkVersion, financeActor, financeAudit, financeError, financeWrite } from './core.js';
import { FinanceLedger } from './ledger.js';
import { deliveryLineExact, documentMoney, theoreticalMoney } from './amounts.js';
import { allocationSum } from './settlements.js';
import { refreshPendingDeliveryReversals } from './pending-delivery.js';
import { edit, endOfMonth, id as recordId, label, row } from './query.js';
import { dueDate, installments } from './terms.js';
import type { FinanceSourceDocument } from './source-snapshot.js';

type Source = {
  kind: string;
  id: string;
  version: number;
  status: string;
  date: string;
  document: string;
  at: string;
  previous: number | null;
};
const syncInput = z.strictObject({ requestId: requestIdSchema });
const eventChange = syncInput.extend({ version: versionSchema });
const evidenceLine = z.strictObject({
  exact: z.string().regex(/^\d{1,24}(\.\d{1,24})?$/),
  mode: z.enum(['含税', '未税', '不含税']),
  rate: z
    .string()
    .trim()
    .regex(/^\d{1,3}(\.\d{1,6})?%?$/),
});
const templateShape = z.strictObject({
  party: accountCodeSchema,
  net: accountCodeSchema,
  tax: accountCodeSchema.optional(),
});
const eventStatus = z.enum([
  'ready',
  'info_pending',
  'waiting_invoice',
  'generated',
  'difference',
  'source_deleted',
  'awaiting_allocation_reversal',
  'cost_pending',
  'costed',
  'no_amount',
  'corrected',
]);
const sourceHash = (snapshot: unknown) =>
  createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
const batchSize = 100;

export class FinanceEvents {
  constructor(private readonly store: Store) {}
  private get db() {
    return this.store.db;
  }

  private party(event: ReturnType<FinanceEvents['getEvent']>, doc: FinanceSourceDocument, date: string) {
    const ar = event.source_kind === 'delivery';
    const id = String(ar ? (doc.customerId ?? '') : (doc.supplierId ?? ''));
    const name = String(ar ? (doc.customerName ?? '') : (doc.supplierName ?? ''));
    const kind = ar ? 'receivable' : 'payable',
      auxiliary = ar ? 'customer' : 'supplier';
    const terms = this.db
      .prepare(
        `SELECT term_type,term_days,term_months,payment_day,cutoff_day,version,options
      FROM fin_party_terms WHERE kind=? AND party_id=?`,
      )
      .get(auxiliary, id);
    return {
      id,
      name,
      kind,
      auxiliary,
      due: dueDate(date, terms),
      terms,
      snapshot: terms ? JSON.stringify(terms) : null,
    };
  }

  private provisional(user: Actor, event: ReturnType<FinanceEvents['getEvent']>, doc: FinanceSourceDocument) {
    const date = String(event.date),
      party = this.party(event, doc, date);
    if (!party.id || !party.name) return;
    const before = this.db
      .prepare(
        `SELECT * FROM fin_obligations
      WHERE event_id=? AND voucher_id IS NULL AND amount_cents>0 AND tax_status<>'superseded' ORDER BY id DESC LIMIT 1`,
      )
      .get(event.id);
    const status = event.status === 'info_pending' ? 'pending' : 'known';
    let key = Number(before?.id);
    if (before)
      this.db
        .prepare(
          'UPDATE fin_obligations SET amount_cents=?,tax_status=?,version=version+1 WHERE id=?',
        )
        .run(event.amount_cents, status, key);
    else
      key = Number(
        this.db
          .prepare(
            `INSERT INTO fin_obligations(kind,party_id,party_name,date,due_date,
      amount_cents,description,event_id,tax_status,terms_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            party.kind,
            party.id,
            party.name,
            date,
            party.due,
            event.amount_cents,
            '来源货款 ' + String(event.source_id),
            event.id,
            status,
            party.snapshot,
          ).lastInsertRowid,
      );
    this.saveInstallments(
      key,
      Number(event.amount_cents),
      date,
      before ? JSON.parse(String(before.terms_snapshot)) : party.terms,
    );
    financeAudit(
      this.store,
      user,
      'provisional',
      'fin_obligations',
      key,
      before ?? null,
      row(this.db, 'fin_obligations', key),
    );
  }

  private saveInstallments(
    key: number,
    amount: number,
    date: string,
    terms: Record<string, unknown> | undefined,
  ) {
    const statement = this.db
      .prepare(`INSERT INTO fin_installments(obligation_id,position,due_date,amount_cents)
      VALUES(?,?,?,?) ON CONFLICT(obligation_id,position) DO UPDATE SET
      amount_cents=excluded.amount_cents,version=version+1`);
    for (const item of installments(amount, date, terms))
      statement.run(key, item.position, item.due, item.amount);
  }

  private sourceQuery() {
    // 只返回尚未扫描的版本，采购投影的来源是同一张到货单。
    return `WITH sources(kind,id,version,status,date,document,at) AS (
      SELECT kind,cast(id AS TEXT),version,status,date,document,updated_at
      FROM flow_documents WHERE kind IN ('delivery','arrival','production') AND status IN ('confirmed','reversed')
      UNION ALL
      SELECT 'legacy_arrival',r.id,coalesce(json_extract(r.document,'$.version'),1),
        CASE WHEN json_extract(r.document,'$.reversed') OR json_extract(r.document,'$.replacedBy') THEN 'reversed'
          ELSE 'confirmed' END,r.date,json_set(r.document,'$.supplierId',p.supplier_id,'$.supplierName',p.supplier_name),r.created_at
      FROM purchase_receipts r JOIN purchases p ON p.id=r.purchase_id
      WHERE json_extract(r.document,'$.flowId') IS NULL AND coalesce(json_extract(r.document,'$.cancelled'),0)=0
      UNION ALL
      SELECT 'stock',m.id,1+coalesce((SELECT max(r.id) FROM stock_movement_revisions r WHERE r.movement_id=m.id),0),
        'confirmed',m.date,json_object('stockId',m.item_id,'deltaUnits',m.delta_units,'reason',m.notes,'createdAt',m.created_at),m.created_at
      FROM stock_movements m WHERE m.action='adjust'
      UNION ALL
      SELECT 'arrival_data_edit',cast(id AS TEXT),1,'difference',substr(at,1,10),document,at
      FROM business_audit WHERE action='receipt-data-edit'
    )`;
  }

  private sources(): Source[] {
    const rows = this.db
      .prepare(
        `${this.sourceQuery()}
    SELECT s.*,o.event_id AS previous FROM sources s
    LEFT JOIN fin_source_observations o ON o.source_kind=s.kind AND o.source_id=s.id
    WHERE o.source_id IS NULL OR o.source_version<>s.version OR o.status<>s.status
    LIMIT ?`,
      )
      .all(batchSize);
    return rows as unknown as Source[];
  }

  unsynced(actor: Actor | null, period: string, lastPeriod = period) {
    financeActor(actor);
    const sourceRows = this.db
      .prepare(
        `WITH sources(kind,id,version,status,date,document,at) AS (
        SELECT kind,cast(id AS TEXT),version,status,date,document,updated_at FROM flow_documents
          WHERE kind IN ('delivery','arrival') AND status='confirmed' AND date BETWEEN ?1 AND ?2
        UNION ALL
        SELECT 'legacy_arrival',r.id,coalesce(json_extract(r.document,'$.version'),1),'confirmed',r.date,
          json_set(r.document,'$.supplierId',p.supplier_id,'$.supplierName',p.supplier_name),r.created_at
          FROM purchase_receipts r JOIN purchases p ON p.id=r.purchase_id
          WHERE r.date BETWEEN ?1 AND ?2 AND json_extract(r.document,'$.flowId') IS NULL
            AND coalesce(json_extract(r.document,'$.cancelled'),0)=0
            AND NOT (coalesce(json_extract(r.document,'$.reversed'),0) OR coalesce(json_extract(r.document,'$.replacedBy'),0))
      )
      SELECT s.*,o.event_id AS previous FROM sources s
      LEFT JOIN fin_source_observations o ON o.source_kind=s.kind AND o.source_id=s.id
      WHERE o.source_id IS NULL OR o.source_version<>s.version OR o.status<>s.status`,
      )
      .all({ '?1': period + '-01', '?2': endOfMonth(lastPeriod) }) as unknown as Source[];
    const policyByDate = new Map<string, string>();
    const termQuery = this.db.prepare('SELECT tax_rate,tax_mode FROM fin_party_terms WHERE kind=? AND party_id=?');
    return sourceRows.map((source) => {
      const doc = JSON.parse(source.document) as FinanceSourceDocument;
      const at = doc.confirmedAt ?? source.at;
      let policy = policyByDate.get(at);
      if (policy === undefined) {
        policy = this.policy(at);
        policyByDate.set(at, policy);
      }
      const result = this.evaluate(source, doc, policy, true, termQuery);
      return {
        id: source.previous,
        source_kind: source.kind,
        source_id: source.id,
        date: source.date,
        amount_cents:
          (source.kind === 'delivery' ? result.money?.gross : result.money?.net) ?? null,
        status: result.status,
        missing: result.missing ?? [],
        problem: result.problem,
        theoretical: result.theoretical?.gross ?? null,
        snapshot: {
          doc,
          money: result.money,
          theoretical: result.theoretical,
          taxSource: result.taxSource,
          financialLines: result.financialLines,
          warnings: result.warnings,
          missing: result.missing,
        },
      };
    });
  }

  private policy(at: string) {
    const row = this.db
      .prepare(
        `SELECT json_extract(document,'$.after.revenueRecognition') AS policy
      FROM business_audit WHERE source='finance' AND entity='fin_settings' AND action='update' AND at<=?
      ORDER BY at DESC,id DESC LIMIT 1`,
      )
      .get(at);
    return row?.policy === 'invoice' ? 'invoice' : 'delivery';
  }

  private evaluate(source: Source, doc: FinanceSourceDocument, policy: string, replacement = false,
    termQuery = this.db.prepare('SELECT tax_rate,tax_mode FROM fin_party_terms WHERE kind=? AND party_id=?')) {
    if (source.kind === 'arrival_data_edit')
      return { status: 'difference', problem: '管理员更正到货统计，原库存流水未变。', money: null };
    if (
      source.status === 'reversed' ||
      (!replacement && (doc.correctionOf || doc.correctionOfReceiptId)) ||
      doc.replacedBy
    )
      return {
        status: 'difference',
        problem: '来源已冲销或更正，请核对原凭证及核销后处理。',
        money: null,
      };
    if (source.kind === 'production') return { status: 'cost_pending', problem: null, money: null };
    if (source.kind === 'stock')
      return { status: 'difference', problem: '请核对盘点调整金额及待处理财产损溢。', money: null };
    try {
      const lines = doc.lines ?? doc.items;
      if (!Array.isArray(lines) || !lines.length) financeError('缺少业务明细。');
      const delivery = source.kind === 'delivery';
      const term = termQuery.get(
          delivery ? 'customer' : 'supplier',
          String(delivery ? doc.customerId : doc.supplierId),
        );
      const choose = (line: unknown, head: unknown, party: unknown) => {
        const values = [line, head, party];
        const index = values.findIndex(
          (v) => v != null && String(v).trim() && String(v).trim() !== '未明确',
        );
        return {
          value: index < 0 ? '' : String(values[index]).trim(),
          source: ['line', 'header', 'party'][index] ?? null,
        };
      };
      const taxSource: { rate: string | null; mode: string | null }[] = [];
      const warnings: string[] = [];
      const values = lines.map((line, index) => {
        const mode = choose(line.taxMode, doc.taxMode, term?.tax_mode);
        const rate = choose(line.taxRate, doc.taxRate, term?.tax_rate);
        taxSource.push({ mode: mode.source, rate: rate.source });
        const tax = { mode: mode.value, rate: rate.value };
        if (source.kind === 'delivery') {
          if (!line.unit) financeError('数量单位无法换算。');
          if (!line.unitPriceExact) financeError('缺少送货价格。');
          return { exact: deliveryLineExact(line.quantity, line.unitPriceExact), ...tax };
        }
        const movement =
          line.stockedQuantity == null && line.stockId != null
            ? this.db
                .prepare(
                  `SELECT sum(delta_units) AS units FROM stock_movements INDEXED BY stock_movements_source
                WHERE source_kind=? AND source_id=? AND item_id=? AND purchase_line_id IS ?`,
                )
                .get(
                  source.kind === 'arrival' ? 'flow_arrival' : 'purchase_receipt',
                  source.id,
                  line.stockId,
                  line.purchaseLineId ?? line.lineId ?? null,
                )
            : null;
        const stocked =
          line.stockedQuantity ??
          (movement?.units == null ? null : quantityString(Number(movement.units)));
        if (stocked == null) financeError('缺少实际入库数量。');
        const stockedUnits = quantityUnits(String(stocked));
        if (
          [line.quantity, line.acceptedQuantity].some(
            (v) => v != null && quantityUnits(String(v)) !== stockedUnits,
          )
        )
          warnings.push('第 ' + (index + 1) + ' 行实收、合格或入库数量不一致，已按实际入库计价。');
        if (stockedUnits === 0) return { exact: '0', mode: '未税', rate: '0' };
        const item = line.item;
        if (!item?.unit) financeError('到货缺少计量单位。');
        if (line.unitPrice == null || !line.priceBasis) financeError('缺少到货价格或计价单位。');
        const exact = purchaseLineAmount({
          ...item,
          quantity: String(stocked),
          unitPrice: line.unitPrice,
          priceBasis: line.priceBasis,
        });
        if (exact === null) financeError('到货数量单位无法换算。');
        return { exact, ...tax };
      });
      const taxMissing = values.some(
        ({ exact, rate, mode }) =>
          Number(exact) > 0 &&
          (!/^\d{1,3}(\.\d{1,6})?%?$/.test(rate) ||
            Number(rate.replace(/%$/, '')) > 100 ||
            !['含税', '未税', '不含税'].includes(mode)),
      );
      const theoretical = theoreticalMoney(values);
      if (taxMissing)
        return {
          status: 'info_pending',
          problem: '待补税率或含税口径。',
          money: theoretical,
          missing: ['tax'],
          taxSource,
          warnings,
          financialLines: values,
          theoretical,
        };
      const money = documentMoney(values);
      if ((source.kind === 'delivery' ? money.gross : money.net) === 0)
        return { status: 'no_amount', problem: null, money, taxSource, warnings };
      return {
        status: source.kind === 'delivery' && policy === 'invoice' ? 'waiting_invoice' : 'ready',
        problem: null,
        money,
        taxSource,
        warnings,
        financialLines: values,
        theoretical,
      };
    } catch (error) {
      const problem = (error as Error).message;
      return {
        status: 'info_pending',
        problem: /\p{Script=Han}/u.test(problem) ? problem : '无法读取来源单据金额资料，请核对数量、单位和价格。',
        money: null,
        missing: [/数量|单位|明细/.test(problem) ? 'quantity' : 'price'],
      };
    }
  }

  sync(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor),
      input = syncInput.parse(raw);
    return financeWrite(this.store, user, 'events.sync', input, () => {
      const start = this.db.prepare('SELECT start_period FROM fin_settings WHERE id=1').get()!
        .start_period;
      if (!start) return { processed: 0, remaining: false };
      const sources = this.sources();
      let processed = 0;
      for (const source of sources) {
        const doc = JSON.parse(source.document);
        const previous =
          source.previous === null
            ? undefined
            : this.db.prepare('SELECT * FROM fin_events WHERE id=?').get(source.previous);
        const hash = sourceHash({ status: source.status, date: source.date, doc });
        const policy = String(
          previous?.revenue_recognition ?? this.policy(doc.confirmedAt ?? source.at),
        );
        const reversal =
          source.status === 'reversed' ||
          doc.correctionOf ||
          doc.correctionOfReceiptId ||
          doc.replacedBy;
        const eventType =
          source.kind === 'delivery'
            ? reversal
              ? 'delivery.reversed'
              : 'delivery.confirmed'
            : source.kind === 'production'
              ? 'production.completed'
              : source.kind === 'stock'
                ? 'stock.adjusted'
                : source.kind === 'arrival_data_edit' || reversal
                  ? 'arrival.corrected'
                  : 'arrival.confirmed';
        if (source.date >= String(start) || previous) {
          if (
            previous?.source_hash === hash &&
            !(
              previous.status === 'info_pending' &&
              !this.db.prepare('SELECT 1 FROM fin_obligations WHERE event_id=?').get(previous.id)
            )
          ) {
            this.observe(source, Number(previous.id));
            continue;
          }
          const result = this.evaluate(source, doc, policy);
          const effective =
            result.status === 'difference' &&
            source.status === 'confirmed' &&
            ['delivery', 'arrival', 'legacy_arrival'].includes(source.kind)
              ? this.evaluate(source, doc, policy, true)
              : result;
          const changed =
            !!previous?.voucher_id ||
            !!(
              previous &&
              this.db
                .prepare(
                  `SELECT 1 FROM fin_obligations o
              JOIN fin_allocations a ON a.obligation_id=o.id WHERE o.event_id=? AND a.status<>'revoked'`,
                )
                .get(previous.id)
            ) ||
            (previous && ['difference', 'source_deleted'].includes(String(previous.status)));
          const status = changed ? 'difference' : result.status;
          const problem = changed ? '来源内容已变更，请核对前后快照及原凭证。' : result.problem;
          const old = previous
            ? { eventId: previous.id, hash: previous.source_hash, status: previous.status }
            : null;
          const snapshot = JSON.stringify({
            doc,
            money: result.money,
            taxSource: result.taxSource,
            theoretical: effective.theoretical,
            financialLines: result.financialLines,
            missing: result.missing,
            warnings: result.warnings,
            previous: old,
          });
          if (previous?.source_hash === hash) {
            const previousId = Number(previous.id);
            this.db
              .prepare(
                'UPDATE fin_events SET status=?,problem=?,snapshot=?,amount_cents=?,version=version+1 WHERE id=?',
              )
              .run(
                result.status,
                result.problem,
                snapshot,
                (source.kind === 'delivery' ? result.money?.gross : result.money?.net) ?? null,
                previousId,
              );
            const after = this.getEvent(previousId);
            if (after.amount_cents) this.provisional(user, after, doc);
            financeAudit(this.store, user, 'refresh', 'fin_events', previousId, previous, after);
            this.observe(source, previousId);
            processed++;
            continue;
          }
          const id = Number(
            this.db
              .prepare(
                `INSERT INTO fin_events
            (source_kind,source_id,event_type,source_version,source_hash,date,amount_cents,snapshot,status,problem,revenue_recognition)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
              )
              .run(
                source.kind,
                source.id,
                eventType,
                source.version,
                hash,
                source.date,
                (eventType === 'arrival.confirmed' ? result.money?.net : result.money?.gross) ??
                  null,
                snapshot,
                status,
                problem,
                policy,
              ).lastInsertRowid,
          );
          if (
            previous &&
            !changed &&
            ['ready', 'info_pending', 'waiting_invoice', 'cost_pending'].includes(
              String(previous.status),
            )
          ) {
            this.db
              .prepare("UPDATE fin_events SET status='superseded',version=version+1 WHERE id=?")
              .run(previous.id);
            financeAudit(
              this.store,
              user,
              'supersede',
              'fin_events',
              Number(previous.id),
              previous,
              this.getEvent(Number(previous.id)),
            );
            this.db
              .prepare(
                "UPDATE fin_obligations SET tax_status='superseded',version=version+1 WHERE event_id=? AND voucher_id IS NULL",
              )
              .run(previous.id);
          }
          if (status === 'info_pending' || status === 'waiting_invoice') {
            const current = this.getEvent(id);
            if (current.amount_cents) this.provisional(user, current, doc);
          }
          this.observe(source, id);
          financeAudit(this.store, user, 'sync', 'fin_events', id, null, this.getEvent(id));
          processed++;
        } else {
          // 保留忽略标记，避免启用前历史占满扫描批次。
          const id = Number(
            this.db
              .prepare(
                `INSERT INTO fin_events
            (source_kind,source_id,event_type,source_version,source_hash,date,snapshot,status)
            VALUES(?,?,?,?,?,?,?,'before_opening')`,
              )
              .run(source.kind, source.id, eventType, source.version, hash, source.date, '{}')
              .lastInsertRowid,
          );
          this.observe(source, id);
          financeAudit(
            this.store,
            user,
            'ignore_before_opening',
            'fin_events',
            id,
            null,
            this.getEvent(id),
          );
        }
      }
      const missing = this.db
        .prepare(
          `SELECT e.* FROM fin_source_observations o JOIN fin_events e ON e.id=o.event_id
        WHERE e.status NOT IN ('source_deleted','before_opening') AND (
          (o.source_kind IN ('delivery','arrival','production') AND NOT EXISTS (SELECT 1 FROM flow_documents f WHERE f.id=cast(o.source_id AS INTEGER) AND f.kind=o.source_kind))
          OR (o.source_kind='legacy_arrival' AND NOT EXISTS (SELECT 1 FROM purchase_receipts p WHERE p.id=o.source_id))
          OR (o.source_kind='stock' AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.id=o.source_id)))
        LIMIT ?`,
        )
        .all(batchSize);
      for (const before of missing) {
        this.db
          .prepare(
            "UPDATE fin_events SET status='source_deleted',problem='来源已物理删除，凭证保留待人工处理。',version=version+1 WHERE id=?",
          )
          .run(before.id);
        financeAudit(
          this.store,
          user,
          'source_deleted',
          'fin_events',
          Number(before.id),
          before,
          this.getEvent(Number(before.id)),
        );
      }
      refreshPendingDeliveryReversals(this.store, user);
      return {
        processed: processed + missing.length,
        remaining: sources.length === batchSize || missing.length === batchSize,
      };
    });
  }

  private observe(source: Source, id: number) {
    this.db
      .prepare(
        `INSERT INTO fin_source_observations VALUES(?,?,?,?,?) ON CONFLICT(source_kind,source_id)
      DO UPDATE SET source_version=excluded.source_version,status=excluded.status,event_id=excluded.event_id`,
      )
      .run(source.kind, source.id, source.version, source.status, id);
  }

  private getEvent(id: number) {
    const row = this.db.prepare('SELECT * FROM fin_events WHERE id=?').get(id);
    if (!row) financeError('财务事件不存在。', 404);
    return { ...row };
  }

  get(actor: Actor | null, rawId: unknown) {
    financeActor(actor);
    const row = this.getEvent(z.coerce.number().int().positive().parse(rawId));
    const snapshot = JSON.parse(String(row.snapshot));
    return {
      ...row,
      snapshot,
      previous: snapshot.previous ? this.getEvent(snapshot.previous.eventId) : null,
    };
  }

  list(actor: Actor | null, query: unknown) {
    financeActor(actor);
    const q = z.object({ status: eventStatus.optional() }).parse(query);
    const { page: requested, pageSize } = parsePaging(query);
    const where = "WHERE (? IS NULL OR status=?) AND status NOT IN ('before_opening','superseded')";
    const args = [q.status ?? null, q.status ?? null];
    const total = Number(
      this.db.prepare('SELECT count(*) AS n FROM fin_events ' + where).get(...args)?.n,
    );
    const page = clampPage(requested ?? 1, pageSize, total);
    const rows = this.db
      .prepare(
        `SELECT id,source_kind,source_id,coalesce(json_extract(snapshot,'$.doc.number'),json_extract(snapshot,'$.doc.reference')) AS number,event_type,date,amount_cents,status,
      voucher_id,problem,version FROM fin_events ${where} ORDER BY date DESC,id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, pageSize, (page - 1) * pageSize);
    return { rows, page, pageSize, filteredRecords: total };
  }

  private assertCurrent(before: ReturnType<FinanceEvents['getEvent']>) {
    const source = this.db
      .prepare(
        `${this.sourceQuery()} SELECT s.* FROM sources s
      JOIN fin_source_observations o ON o.source_kind=s.kind AND o.source_id=s.id
      WHERE s.kind=? AND s.id=? AND o.event_id=? AND o.source_version=s.version AND o.status=s.status`,
      )
      .get(before.source_kind, before.source_id, before.id);
    if (
      !source ||
      before.source_hash !==
        sourceHash({
          status: source.status,
          date: source.date,
          doc: JSON.parse(String(source.document)),
        })
    )
      financeError('来源已更新或删除，请先重新同步。', 409);
  }

  resolve(
    actor: Actor | null,
    rawId: unknown,
    raw: unknown,
    taxSource?: { rate: string; mode: string }[],
  ) {
    const user = financeActor(actor, 'finance:edit'),
      id = z.coerce.number().int().positive().parse(rawId);
    const input = eventChange
      .extend({
        evidence: z.string().trim().max(1000).optional(),
        lines: z.array(evidenceLine).min(1).max(1000),
      })
      .parse(raw);
    return financeWrite(this.store, user, 'events.resolve', { ...input, id }, () => {
      const before = this.getEvent(id);
      checkVersion(before, input.version);
      if (before.status !== 'info_pending') financeError('只有资料待补事件可补充财务资料。', 409);
      this.assertCurrent(before);
      const snapshot = JSON.parse(String(before.snapshot));
      const lines = snapshot.doc.lines ?? snapshot.doc.items;
      if (!Array.isArray(lines) || lines.length !== input.lines.length)
        financeError('财务补充明细须与原单行数一致。');
      const money = documentMoney(input.lines);
      const delivery = before.source_kind === 'delivery';
      const status =
        delivery && before.revenue_recognition === 'invoice' ? 'waiting_invoice' : 'ready';
      const amount = delivery ? money.gross : money.net;
      if (
        !amount &&
        this.db
          .prepare(
            `SELECT 1 FROM fin_allocations a JOIN fin_obligations o ON o.id=a.obligation_id
        WHERE o.event_id=? AND a.status<>'revoked'`,
          )
          .get(id)
      )
        financeError('已有核销，请先撤销再将货款改为零。');
      this.db
        .prepare(
          'UPDATE fin_events SET status=?,amount_cents=?,snapshot=?,problem=NULL,version=version+1 WHERE id=?',
        )
        .run(
          amount ? status : 'no_amount',
          amount,
          JSON.stringify({
            ...snapshot,
            money,
            theoretical: snapshot.theoretical ?? theoreticalMoney(input.lines),
            evidence: input.evidence,
            financialLines: input.lines,
            missing: [],
            taxSource: taxSource ?? input.lines.map(() => ({ rate: 'manual', mode: 'manual' })),
          }),
          id,
        );
      const after = this.getEvent(id);
      if (
        this.db
          .prepare('SELECT 1 FROM fin_obligations WHERE event_id=? AND voucher_id IS NULL')
          .get(id) ||
        status === 'waiting_invoice'
      )
        this.provisional(user, after, snapshot.doc);
      financeAudit(this.store, user, 'resolve', 'fin_events', id, before, after);
      return after.status === 'ready' &&
        this.db
          .prepare('SELECT 1 FROM fin_obligations WHERE event_id=? AND voucher_id IS NULL')
          .get(id)
        ? this.generate(user, id, {
            version: Number(after.version),
            requestId: 'resolve:' + id + ':' + after.version,
          })
        : after;
    });
  }

  resolveBatch(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:edit');
    const v = syncInput
      .extend({
        items: z
          .array(z.strictObject({ id: recordId, version: versionSchema }))
          .min(1)
          .max(200)
          .optional(),
        partyId: recordId.optional(),
        kind: z.enum(['customer', 'supplier']).optional(),
        period: z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
          .optional(),
        rate: evidenceLine.shape.rate.optional(),
        mode: evidenceLine.shape.mode.optional(),
        noTax: z.boolean().default(false),
        usePartyDefault: z.boolean().default(false),
        evidence: z.string().trim().max(1000).optional(),
      })
      .parse(raw);
    if (!v.items && (!v.partyId || !v.kind || !v.period))
      financeError('请选择单据或指定往来单位和月份。');
    return financeWrite(this.store, user, 'events.batch', { ...v }, () => {
      const selected =
        v.items ??
        this.db
          .prepare(
            `SELECT id,version FROM fin_events
        WHERE status='info_pending' AND substr(date,1,7)=? AND
        json_extract(snapshot,?)=? AND (source_kind='delivery')=? ORDER BY id LIMIT 201`,
          )
          .all(
            v.period!,
            v.kind === 'customer' ? '$.doc.customerId' : '$.doc.supplierId',
            v.partyId!,
            Number(v.kind === 'customer'),
          )
          .map((r) => ({ id: Number(r.id), version: Number(r.version) }));
      if (selected.length > 200) financeError('每批最多补录 200 张。');
      return selected.map((item) => {
        const event = this.getEvent(item.id),
          snapshot = JSON.parse(String(event.snapshot));
        const party = this.party(event, snapshot.doc, String(event.date));
        const defaults = v.usePartyDefault
          ? this.db
              .prepare('SELECT tax_rate,tax_mode FROM fin_party_terms WHERE kind=? AND party_id=?')
              .get(party.auxiliary, party.id)
          : null;
        const lines = snapshot.financialLines;
        if (!Array.isArray(lines)) financeError('缺少价格或数量，请逐行补录。');
        return this.resolve(
          user,
          item.id,
          {
            version: item.version,
            requestId: 'tax-batch:' + item.id + ':' + item.version,
            evidence: v.evidence,
            lines: lines.map((line) => ({
              exact: line.exact,
              rate: v.noTax ? '0' : (v.rate ?? defaults?.tax_rate ?? line.rate),
              mode: v.noTax ? '未税' : (v.mode ?? defaults?.tax_mode ?? line.mode),
            })),
          },
          lines.map((_, i) => ({
            rate: v.noTax
              ? 'no_tax'
              : v.rate
                ? 'manual'
                : defaults?.tax_rate
                  ? 'party'
                  : (snapshot.taxSource?.[i]?.rate ?? 'manual'),
            mode: v.noTax
              ? 'no_tax'
              : v.mode
                ? 'manual'
                : defaults?.tax_mode
                  ? 'party'
                  : (snapshot.taxSource?.[i]?.mode ?? 'manual'),
          })),
        );
      });
    });
  }

  templates(actor: Actor | null) {
    financeActor(actor, 'finance:close');
    return this.db
      .prepare('SELECT * FROM fin_templates ORDER BY name')
      .all()
      .map((row) => ({
        name: String(row.name),
        version: Number(row.version),
        mapping: JSON.parse(String(row.mapping)) as Record<string, string>,
      }));
  }

  saveTemplate(actor: Actor | null, raw: unknown) {
    const user = financeActor(actor, 'finance:close');
    const input = eventChange
      .extend({ name: label, mapping: z.record(z.string().max(40), accountCodeSchema) })
      .parse(raw);
    return financeWrite(this.store, user, 'templates.update', input, () => {
      const get = () => {
        const record = this.db.prepare('SELECT * FROM fin_templates WHERE name=?').get(input.name);
        if (!record) financeError('凭证模板不存在。', 404);
        return {
          name: String(record.name),
          version: Number(record.version),
          mapping: JSON.parse(String(record.mapping)) as Record<string, string>,
        };
      };
      const before = get();
      checkVersion(before, input.version);
      if (
        Object.keys(before.mapping).sort().join(',') !== Object.keys(input.mapping).sort().join(',')
      )
        financeError('凭证模板必须完整填写原有科目映射。');
      const check = this.db.prepare(`SELECT 1 FROM fin_accounts WHERE code=? AND enabled=1
        AND NOT EXISTS(SELECT 1 FROM fin_accounts a WHERE a.parent_code=fin_accounts.code)`);
      for (const code of Object.values(input.mapping))
        if (!check.get(code)) financeError('模板科目须为已启用的末级科目。');
      this.db
        .prepare('UPDATE fin_templates SET mapping=?,version=version+1 WHERE name=?')
        .run(JSON.stringify(input.mapping), input.name);
      const after = get();
      financeAudit(this.store, user, 'update', 'fin_templates', null, before, after);
      return after;
    });
  }

  correct(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      id = recordId.parse(rawId);
    const input = edit.extend({ date: dateSchema, reason: label }).parse(raw);
    return financeWrite(this.store, user, 'events.correct', { ...input, id }, () => {
      const event = this.getEvent(id);
      checkVersion(event, input.version);
      if (
        !['difference', 'source_deleted'].includes(String(event.status)) ||
        !['delivery', 'arrival', 'legacy_arrival'].includes(String(event.source_kind))
      )
        financeError('该来源不适用往来全额红冲。', 409);
      const snapshot = JSON.parse(String(event.snapshot)),
        doc = snapshot.doc;
      const source = this.db
        .prepare(`${this.sourceQuery()} SELECT * FROM sources WHERE kind=? AND id=?`)
        .get(event.source_kind, event.source_id) as unknown as Source | undefined;
      if (source) this.assertCurrent(event);
      const previousRef = doc?.correctionOfReceiptId ?? doc?.correctionOf;
      const previousId =
        previousRef == null ? String(event.source_id) : String(previousRef).replace(/^flow-/, '');
      const previousKind =
        previousRef != null && /^flow-/.test(String(previousRef))
          ? 'arrival'
          : doc?.correctionOfReceiptId && !/^flow-/.test(String(previousRef))
            ? 'legacy_arrival'
            : String(event.source_kind);
      const original = this.db
        .prepare(
          `SELECT o.* FROM fin_obligations o JOIN fin_events e ON e.id=o.event_id
        LEFT JOIN fin_vouchers v ON v.id=o.voucher_id WHERE e.source_kind=? AND e.source_id=? AND o.amount_cents>0
        AND o.tax_status<>'superseded' AND (o.voucher_id IS NULL OR v.status<>'void') ORDER BY o.id DESC LIMIT 1`,
        )
        .get(previousKind, previousId);
      const ledger = new FinanceLedger(this.store);
      ledger.openPeriod(user, input.date);
      if (original) {
        const allocated = Number(
          this.db.prepare('SELECT ' + allocationSum('a.obligation_id=?') + ' AS n').get(original.id)
            ?.n,
        );
        if (
          allocated ||
          this.db
            .prepare(
              `SELECT 1 FROM fin_allocations a JOIN fin_vouchers v ON v.id=a.voucher_id
          WHERE a.obligation_id=? AND v.status NOT IN ('posted','void')`,
            )
            .get(original.id)
        )
          financeError('请先撤销并记账该往来单的核销。', 409);
        if (
          this.db.prepare('SELECT 1 FROM fin_invoice_links WHERE obligation_id=?').get(original.id)
        )
          financeError('请先处理已关联发票。', 409);
        if (!original.voucher_id) {
          this.db
            .prepare(
              "UPDATE fin_obligations SET tax_status='superseded',version=version+1 WHERE id=?",
            )
            .run(original.id);
          financeAudit(
            this.store,
            user,
            'supersede',
            'fin_obligations',
            Number(original.id),
            original,
            row(this.db, 'fin_obligations', Number(original.id)),
          );
        } else {
          const voucher = ledger.get(user, original.voucher_id).header;
          const ref = {
            version: Number(voucher.version),
            requestId: 'event-correct:' + id + ':' + input.version,
          };
          const existing = this.db
            .prepare("SELECT id FROM fin_vouchers WHERE reversal_of=? AND status<>'void'")
            .get(voucher.id);
          if (voucher.status === 'posted' && !existing) {
            const red = ledger.reverse(
              user,
              voucher.id,
              { ...ref, date: input.date, description: input.reason },
              true,
            );
            const key = Number(
              this.db
                .prepare(
                  `INSERT INTO fin_obligations(kind,party_id,party_name,date,due_date,amount_cents,description,event_id,voucher_id,reversal_of)
            VALUES(?,?,?,?,?,?,?,?,?,?)`,
                )
                .run(
                  original.kind,
                  original.party_id,
                  original.party_name,
                  input.date,
                  input.date,
                  -Number(original.amount_cents),
                  input.reason,
                  id,
                  red.header.id,
                  original.id,
                ).lastInsertRowid,
            );
            financeAudit(
              this.store,
              user,
              'reverse',
              'fin_obligations',
              key,
              null,
              row(this.db, 'fin_obligations', key),
            );
          } else if (voucher.status !== 'posted')
            ledger.transition(user, voucher.id, 'void', ref, true);
        }
      }
      let status = 'corrected';
      if (source?.status === 'confirmed' && !doc?.replacedBy) {
        const result = this.evaluate(source, doc, String(event.revenue_recognition), true);
        status = result.status;
        this.db.prepare('UPDATE fin_events SET snapshot=?,amount_cents=?,problem=? WHERE id=?').run(
          JSON.stringify({
            ...snapshot,
            money: result.money,
            theoretical: result.theoretical,
            financialLines: result.financialLines,
            missing: result.missing,
            taxSource: result.taxSource,
            warnings: result.warnings,
          }),
          (source.kind === 'delivery' ? result.money?.gross : result.money?.net) ?? null,
          result.problem,
          id,
        );
      }
      this.db
        .prepare('UPDATE fin_events SET status=?,voucher_id=NULL,version=version+1 WHERE id=?')
        .run(status, id);
      const after = this.getEvent(id);
      if ((status === 'info_pending' || status === 'waiting_invoice') && after.amount_cents)
        this.provisional(user, after, doc);
      financeAudit(this.store, user, 'correct', 'fin_events', id, event, after);
      return status === 'ready'
        ? this.generate(
            user,
            id,
            {
              version: Number(after.version),
              requestId: 'event-rebuild:' + id + ':' + input.version,
            },
            input.date,
          )
        : after;
    });
  }

  acknowledgeStatisticalCorrection(actor: Actor | null, rawId: unknown, raw: unknown) {
    const user = financeActor(actor, 'finance:edit'),
      id = recordId.parse(rawId);
    const v = edit.extend({ reason: label }).parse(raw);
    return financeWrite(this.store, user, 'events.acknowledge', { ...v, id }, () => {
      const before = this.getEvent(id);
      checkVersion(before, v.version);
      if (before.source_kind !== 'arrival_data_edit' || before.status !== 'difference')
        financeError('此操作仅适用于未调整库存的到货统计更正。', 409);
      this.db
        .prepare("UPDATE fin_events SET status='corrected',version=version+1 WHERE id=?")
        .run(id);
      const after = this.getEvent(id);
      financeAudit(this.store, user, 'acknowledge', 'fin_events', id, before, {
        ...after,
        reason: v.reason,
      });
      return after;
    });
  }

  generate(actor: Actor | null, rawId: unknown, raw: unknown, correctedDate?: string) {
    const user = financeActor(actor, 'finance:edit'),
      id = z.coerce.number().int().positive().parse(rawId);
    const input = eventChange.parse(raw);
    return financeWrite(this.store, user, 'events.generate', { ...input, id }, () => {
      const before = this.getEvent(id);
      checkVersion(before, input.version);
      if (before.status === 'info_pending' && before.amount_cents) return before;
      if (before.status !== 'ready' || before.voucher_id) financeError('该事件尚不能制单。', 409);
      const snapshot = JSON.parse(String(before.snapshot)),
        doc = snapshot.doc;
      this.assertCurrent(before);
      const delivery = before.source_kind === 'delivery';
      const partyId = String(delivery ? (doc.customerId ?? '') : (doc.supplierId ?? ''));
      const partyName = String(delivery ? (doc.customerName ?? '') : (doc.supplierName ?? ''));
      if (!partyId || !partyName) financeError('来源缺少往来单位快照。');
      const party = delivery ? 'customer' : 'supplier';
      const mapping = templateShape.parse(
        JSON.parse(
          String(
            this.db
              .prepare('SELECT mapping FROM fin_templates WHERE name=?')
              .get(delivery ? 'delivery.confirmed' : 'arrival.confirmed')?.mapping,
          ),
        ),
      );
      const money = snapshot.money;
      const amount = Number(before.amount_cents);
      const description =
        (delivery ? '送货确认 ' : '到货暂估 ') +
        String(doc.number ?? doc.reference ?? before.source_id);
      const entry = (
        accountCode: string,
        debit: number,
        credit: number,
        auxiliary: FinanceEntry['auxiliary'] = null,
      ) => ({ accountCode, description, debit, credit, auxiliary, cashFlow: null });
      const entries = delivery
        ? [
            entry(mapping.party, amount, 0, { kind: party, id: partyId, name: partyName }),
            ...(money.net ? [entry(mapping.net, 0, money.net)] : []),
            ...(money.tax ? [entry(mapping.tax!, 0, money.tax)] : []),
          ]
        : [
            entry(mapping.net, amount, 0),
            entry(mapping.party, 0, amount, { kind: party, id: partyId, name: partyName }),
          ];
      const date = dateSchema.parse(correctedDate ?? before.date);
      const terms = this.party(before, doc, date);
      const voucher = new FinanceLedger(this.store).createFromEvent(user, id, {
        requestId: input.requestId,
        date,
        description,
        entries,
      });
      const provisional = this.db
        .prepare(
          `SELECT * FROM fin_obligations WHERE event_id=? AND voucher_id IS NULL
        AND tax_status<>'superseded' LIMIT 1`,
        )
        .get(id);
      if (provisional)
        this.db
          .prepare(
            `UPDATE fin_obligations SET voucher_id=?,amount_cents=?,
        tax_status='known',version=version+1 WHERE id=?`,
          )
          .run(voucher.header.id, amount, provisional.id);
      const obligation = provisional
        ? null
        : this.db
            .prepare(
              `INSERT INTO fin_obligations
        (kind,party_id,party_name,date,due_date,amount_cents,description,event_id,voucher_id,terms_snapshot)
        VALUES(?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              delivery ? 'receivable' : 'payable',
              partyId,
              partyName,
              date,
              terms.due,
              amount,
              description,
              id,
              voucher.header.id,
              terms.snapshot,
            );
      this.db
        .prepare(
          "UPDATE fin_events SET voucher_id=?,status='generated',version=version+1 WHERE id=?",
        )
        .run(voucher.header.id, id);
      const after = this.getEvent(id);
      const obligationId = Number(provisional?.id ?? obligation?.lastInsertRowid);
      this.saveInstallments(
        obligationId,
        amount,
        date,
        provisional ? JSON.parse(String(provisional.terms_snapshot)) : terms.terms,
      );
      financeAudit(
        this.store,
        user,
        'create',
        'fin_obligations',
        obligationId,
        provisional ?? null,
        this.db.prepare('SELECT * FROM fin_obligations WHERE id=?').get(obligationId),
      );
      financeAudit(this.store, user, 'generate', 'fin_events', id, before, after);
      return after;
    });
  }
}
