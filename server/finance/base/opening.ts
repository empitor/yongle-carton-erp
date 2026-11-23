/**
 * 财务启用：期初余额逐行校验写进 fin_opening，按客户、供应商记的科目由明细加出合计行，
 * 借贷平衡后开第一个会计期间、定下纳税人身份，期初的应收应付记成往来。FinanceSettings.enable 调这里。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { z } from 'zod';
import type { openingSchema } from '../../../shared/finance/index.js';
import { financeError } from './core.js';
import { safeCents } from './amounts.js';

type OpeningInput = z.output<typeof openingSchema>;
type OpeningRow = OpeningInput['rows'][number];
/** 期初用到的科目几列；leaf 为 1 是末级 */
type OpeningAccount = { name: string; auxiliary: string | null; enabled: number; leaf: number };
type Balances = Map<string, { control?: bigint[]; detail: bigint[] }>;

/**
 * 应收、应付、预收、预付这些要按客户或供应商记的科目，页面上只填各单位的明细行，
 * 科目合计行在这里按明细加出来；只填了合计没填单位的，提示按单位填。
 */
function withControlRows(input: readonly OpeningRow[], accounts: Map<string, OpeningAccount>) {
  const rows = [...input];
  const auxiliaryAccounts = new Map<string, OpeningAccount>();
  for (const r of rows) {
    const account = accounts.get(r.accountCode);
    if (account?.auxiliary) auxiliaryAccounts.set(r.accountCode, account);
  }
  for (const [code, account] of auxiliaryAccounts) {
    const details = rows.filter((r) => r.accountCode === code && r.auxiliary);
    const control = rows.find((r) => r.accountCode === code && !r.auxiliary);
    if (!details.length) {
      if (control && [control.debit, control.credit, control.yearDebit, control.yearCredit].some(Boolean))
        financeError(
          `科目 ${code} ${account.name} 要按${account.auxiliary === 'customer' ? '客户' : '供应商'}填辅助明细：每个单位一行，选好是哪个单位。`,
        );
      continue;
    }
    if (control) continue;
    const total = (key: 'debit' | 'credit' | 'yearDebit' | 'yearCredit') =>
      details.reduce((n, r) => n + BigInt(r[key]), 0n);
    const balance = total('debit') - total('credit');
    rows.push({
      accountCode: code,
      auxiliary: null,
      debit: safeCents(balance > 0n ? balance : 0n),
      credit: safeCents(balance < 0n ? -balance : 0n),
      yearDebit: safeCents(total('yearDebit')),
      yearCredit: safeCents(total('yearCredit')),
    });
  }
  return rows;
}

/** 一行期初：科目要启用、是末级，借贷只填一方，辅助项和科目对得上，科目加辅助项不重复；返回这行的科目 */
function checkOpeningRow(row: OpeningRow, account: OpeningAccount | undefined, unique: Set<string>) {
  if (!account?.enabled || !account.leaf) financeError('期初科目必须启用且为末级。');
  if (row.debit > 0 && row.credit > 0) financeError('期初余额只可填一方。');
  if (row.auxiliary && account.auxiliary !== row.auxiliary.kind) financeError('期初辅助项与科目不一致。');
  const key = JSON.stringify([row.accountCode, row.auxiliary?.id]);
  if (unique.has(key)) financeError('期初科目或辅助明细重复。');
  unique.add(key);
  return account;
}

/** 期初逐行校验、写进 fin_opening，按科目汇出辅助明细和合计行的余额，算借贷差 */
function insertOpening(db: DatabaseSync, rows: readonly OpeningRow[], accounts: Map<string, OpeningAccount>) {
  const balances: Balances = new Map();
  const unique = new Set<string>();
  const insert = db.prepare(`INSERT INTO fin_opening
    (account_code,auxiliary_kind,auxiliary_id,auxiliary_name,debit,credit,year_debit,year_credit)
    VALUES(?,?,?,?,?,?,?,?)`);
  let net = 0n,
    yearNet = 0n;
  for (const row of rows) {
    const account = checkOpeningRow(row, accounts.get(row.accountCode), unique),
      auxiliary = row.auxiliary;
    const amounts = [row.debit, row.credit, row.yearDebit, row.yearCredit].map(BigInt);
    if (account.auxiliary) {
      const group = balances.get(row.accountCode) ?? { detail: [0n, 0n, 0n, 0n] };
      if (auxiliary) group.detail = group.detail.map((amount, index) => amount + amounts[index]);
      else group.control = amounts;
      balances.set(row.accountCode, group);
    }
    if (!auxiliary) {
      net += amounts[0] - amounts[1];
      yearNet += amounts[2] - amounts[3];
    }
    insert.run(
      row.accountCode,
      auxiliary?.kind ?? null,
      auxiliary?.id ?? null,
      auxiliary?.name ?? null,
      row.debit,
      row.credit,
      row.yearDebit,
      row.yearCredit,
    );
    db.prepare('UPDATE fin_accounts SET used=1 WHERE code=?').run(row.accountCode);
  }
  return { balances, net, yearNet };
}

/** 合计行要和辅助明细对得上，期初余额和本年累计各自借贷平衡 */
function checkBalanced({ balances, net, yearNet }: ReturnType<typeof insertOpening>) {
  for (const [code, { control, detail }] of balances) {
    if (
      !control ||
      control[0] - control[1] !== detail[0] - detail[1] ||
      control[2] !== detail[2] ||
      control[3] !== detail[3]
    )
      financeError(`科目 ${code} 的期初及本年累计与辅助明细不一致。`);
  }
  if (net !== 0n || yearNet !== 0n) financeError('期初余额和本年累计必须分别借贷平衡。');
}

/** 写进期初、开第一个期间、定下纳税人身份，期初的应收应付记成往来；返回实际写进的期初行（含加出来的合计行） */
export function enableOpening(db: DatabaseSync, input: OpeningInput, accounts: Map<string, OpeningAccount>) {
  const rows = withControlRows(input.rows, accounts);
  checkBalanced(insertOpening(db, rows, accounts));
  db.prepare("INSERT INTO fin_periods(period,status) VALUES(?,'open')").run(input.period);
  db.prepare('UPDATE fin_settings SET start_period=?,taxpayer=?,version=version+1 WHERE id=1').run(
    input.period,
    input.taxpayer,
  );
  db.prepare(
    `INSERT INTO fin_obligations(kind,party_id,party_name,date,amount_cents,description,opening_id)
    SELECT CASE WHEN account_code LIKE '1122%' THEN 'receivable' ELSE 'payable' END,
      auxiliary_id,auxiliary_name,?,CASE WHEN account_code LIKE '1122%' THEN debit-credit ELSE credit-debit END,'期初往来',id
    FROM fin_opening WHERE auxiliary_id IS NOT NULL AND debit<>credit AND
      (account_code LIKE '1122%' OR account_code LIKE '2202%')`,
  ).run(input.period + '-01');
  return rows;
}
