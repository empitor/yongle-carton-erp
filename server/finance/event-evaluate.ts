import type { DatabaseSync } from 'node:sqlite';
import { arrivalLineValue, deliveryLineValue } from '../../shared/business/index.js';
import { errorMessage, quantityUnits } from '../../shared/core/index.js';
import { one, rows } from '../core/index.js';
import { financeError } from './core.js';
import { documentMoney, theoreticalMoney } from './amounts.js';
import type { SourceRow } from './business-source.js';
import type { DocumentMoney, EventSnapshot, FinanceSourceDocument, FinanceSourceLine } from './source-snapshot.js';
import { taxModes } from '../../shared/finance/index.js';

type TaxTerms = { tax_rate: string | null; tax_mode: string | null };
/** 查往来单位默认税率和含税口径的函数：kind 是客户还是供应商，id 是往来单位编号 */
type PartyTaxTerms = (kind: 'customer' | 'supplier', id: string) => TaxTerms | undefined;
const taxTermsRow = rows.fin_party_terms.pick({ tax_rate: true, tax_mode: true });

/** 往来单位的默认税率和含税口径；批量算时把同一个函数传进来，同一个单位只查一次 */
export function partyTaxTerms(db: DatabaseSync): PartyTaxTerms {
  const found = new Map<string, TaxTerms | undefined>();
  return (kind, id) => {
    const key = kind + ':' + id;
    if (!found.has(key))
      found.set(key, one(db, taxTermsRow, 'SELECT tax_rate,tax_mode FROM fin_party_terms WHERE kind=? AND party_id=?', kind, id));
    return found.get(key);
  };
}

/**
 * “改了什么”比金额的口径：快照里缺的是税率（missing 含 tax）时，记进往来的金额只是理论金额（不含税）；
 * 补过税率的是含税（送货）或不含税（到货）的正式金额。两边不同口径时按理论金额比（event-changes.ts）。
 */
export function taxBasis(snapshot: Pick<EventSnapshot, 'missing' | 'theoretical'>) {
  return {
    taxPending: snapshot.missing?.includes('tax') ?? false,
    theoretical: snapshot.theoretical?.gross ?? null,
  };
}

/**
 * 送货、到货“有差异”的说明：已撤销、已被更正替代的单据红字冲销后不再重做（替代单另行入账），
 * 改过内容的、更正单本身红冲后按单据现在的内容重做。界面的按钮和确认窗也按这个分（列表的 rebuild）。
 */
export function differenceProblem(status: string, doc: FinanceSourceDocument, changed: boolean, listed = true) {
  // 被更正替代的原单状态也是 reversed，先认替代，和红冲后的结果说明（“单据已被更正替代，由替代单入账”）一致
  if (doc.replacedBy) return '单据已被更正替代，请核对原来那张凭证和收付款核销，再点“红字冲销”，由替代单入账。';
  if (status === 'reversed') return '单据已撤销，请核对原来那张凭证和收付款核销，再点“红字冲销”，不再重做。';
  // “改了什么”只列往来单位、日期、金额、明细的数量单价税率这些；改的是别的（比如明细关联的订单、库存品）时那一节不显示，
  // 说明就不叫人去看它
  if (changed && !listed)
    return '单据内容改过了，往来单位、日期、金额、数量、单价、税率都没变，核对原来那张凭证后点“红字冲销并重做”。';
  if (changed) return '单据内容改过了，改了什么见详情里的“改了什么”，核对原来那张凭证后点“红字冲销并重做”。';
  return '这是一张更正单，请核对原单的凭证和收付款核销，再点“红字冲销并重做”。';
}

type FinancialLine = { exact: string; mode: string; rate: string };
type TaxSource = { rate: string | null; mode: string | null };
/** 按单据内容算出的状态、说明、金额和逐行资料（写进事件快照） */
export type Evaluation = {
  status: 'cost_pending' | 'difference' | 'info_pending' | 'no_amount' | 'waiting_invoice' | 'ready';
  problem: string | null;
  money: DocumentMoney | null;
  missing?: ('tax' | 'quantity' | 'price')[];
  taxSource?: TaxSource[];
  warnings?: string[];
  financialLines?: FinancialLine[];
  theoretical?: DocumentMoney;
};
/**
 * policy 是收入确认口径；replacement 为 true 时有效的更正单按一张正常的新单据算；
 * taxTerms 查往来单位默认税率，批量算时传进来复用。
 */
type EvaluateOptions = { policy: string; replacement?: boolean; taxTerms?: PartyTaxTerms };

/**
 * 按单据现在的内容算财务事件的状态和金额：要不要补税率、是不是 0 元、能不能制单，有差异时给说明。
 */
export function evaluateSource(
  db: DatabaseSync,
  source: SourceRow,
  doc: FinanceSourceDocument,
  options: EvaluateOptions,
): Evaluation {
  // 完工单没有凭证，成本由月末成本计算按库存流水算：冲销退回的领料、扣回的成品都有冲销流水，
  // 成本计算按原成本冲回。这里只等成本计算，不能当成要红冲的差异，否则谁都处理不了。
  if (source.kind === 'production')
    return {
      status: 'cost_pending',
      problem: source.status === 'reversed' ? '完工单已冲销，月末成本计算按冲销流水冲回原成本。' : null,
      money: null,
    };
  if (
    source.status === 'reversed' ||
    (!options.replacement && (doc.correctionOf || doc.correctionOfReceiptId)) ||
    doc.replacedBy
  )
    return { status: 'difference', problem: differenceProblem(source.status, doc, false), money: null };
  if (source.kind === 'stock') return { status: 'difference', problem: '请核对盘点调整金额及待处理财产损溢。', money: null };
  return evaluateLines(source, doc, options.policy, options.taxTerms ?? partyTaxTerms(db));
}

/** 税率、含税口径按明细、往来单位的默认依次取第一个写清了的（“未明确”不算），记下从哪来的 */
function choose(line: string | null | undefined, party: string | null | undefined) {
  const values = [line, party];
  const index = values.findIndex((v) => v != null && v.trim() && v.trim() !== '未明确');
  return { value: index < 0 ? '' : String(values[index]).trim(), source: ['line', 'party'][index] ?? null };
}
const validTax = ({ mode, rate }: { mode: string; rate: string }) =>
  /^\d{1,3}(\.\d{1,6})?%?$/.test(rate) && Number(rate.replace(/%$/, '')) <= 100 && taxModes.some((m) => m === mode);
// 算出来就是 0 的行（数量为 0，或单价明确填了 0）不管什么口径金额都是 0：没写清税率口径时按“未税 / 0”计，
// 不算资料待补，否则要人给一张 0 元单子补税率。单价没填是未知，前面已按缺价格转资料待补，到不了这里。
const priced = (exact: string, tax: { mode: string; rate: string }) =>
  /^0+(\.0+)?$/.test(exact) && !validTax(tax) ? { exact, mode: '未税', rate: '0' } : { exact, ...tax };

/** 算一张单据逐行金额时的上下文：哪种单据、往来单位默认税率，逐行记下税率来源和提醒，缺资料时缺的是数量还是价格 */
type LineContext = {
  kind: SourceRow['kind'];
  term: TaxTerms | undefined;
  taxSource: TaxSource[];
  warnings: string[];
  lacking: 'quantity' | 'price';
};

/** 一行明细的精确金额、含税口径和税率；缺资料时报错（按出错时正在算哪一步记缺什么） */
function lineValue(context: LineContext, line: FinanceSourceLine, index: number): FinancialLine {
  const mode = choose(line.taxMode, context.term?.tax_mode);
  const rate = choose(line.taxRate, context.term?.tax_rate);
  context.taxSource.push({ mode: mode.source, rate: rate.source });
  const tax = { mode: mode.value, rate: rate.value };
  context.lacking = 'quantity';
  // 到货：实收、合格和入库数量不一致的提醒一句，金额按实际入库算（入库数量写坏了在这里就报缺数量）
  if (context.kind === 'arrival' && line.stockedQuantity != null) {
    const stockedUnits = quantityUnits(line.stockedQuantity);
    if ([line.quantity, line.acceptedQuantity].some((v) => v != null && quantityUnits(v) !== stockedUnits))
      context.warnings.push('第 ' + (index + 1) + ' 行实收、合格或入库数量不一致，已按实际入库计价。');
    if (stockedUnits === 0) return { exact: '0', mode: '未税', rate: '0' };
  }
  // 逐行金额和经营概况同一处算（shared/business 的 document-value.ts）
  const value = context.kind === 'delivery' ? deliveryLineValue(line) : arrivalLineValue(line);
  if ('lacking' in value) {
    context.lacking = value.lacking;
    financeError(value.message);
  }
  return priced(value.exact, tax);
}

/** 送货、到货按明细算金额：缺税率的待补（先记理论金额），0 元的不挂往来，齐了的可记账（开票确认收入的送货等开票） */
function evaluateLines(source: SourceRow, doc: FinanceSourceDocument, policy: string, taxTerms: PartyTaxTerms): Evaluation {
  const delivery = source.kind === 'delivery';
  // 资料待补时缺的是数量还是价格，按出错时正在算哪一步定，不去匹配报错文字：
  // 报错里碰巧带了“单位”“数量”（比如“缺少到货价格或计价单位”）也不会分错。
  const context: LineContext = { kind: source.kind, term: undefined, taxSource: [], warnings: [], lacking: 'quantity' };
  try {
    const lines = doc.lines;
    if (!lines?.length) financeError('缺少业务明细。');
    context.term = taxTerms(delivery ? 'customer' : 'supplier', String(delivery ? doc.customerId : doc.supplierId));
    const values = lines.map((line, index) => lineValue(context, line, index));
    context.lacking = 'price';
    const { taxSource, warnings } = context;
    const theoretical = theoreticalMoney(values);
    if (values.some((line) => !validTax(line)))
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
    // 理论金额 0 也要带上：月度台账按它取金额，没有就算成“缺价格”。
    const status = (delivery ? money.gross : money.net) === 0 ? 'no_amount' : delivery && policy === 'invoice' ? 'waiting_invoice' : 'ready';
    return { status, problem: null, money, taxSource, warnings, financialLines: values, theoretical };
  } catch (error) {
    const problem = errorMessage(error);
    return {
      status: 'info_pending',
      problem: /\p{Script=Han}/u.test(problem) ? problem : '无法读取来源单据金额资料，请核对数量、单位和价格。',
      money: null,
      missing: [context.lacking],
    };
  }
}
