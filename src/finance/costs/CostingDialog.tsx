import { useEffect, useState, type ReactNode } from 'react';
import { FormMessage, FormSection, centsInput, toCents, Loading } from '../../ui/index';
import { UNITS_PER_QUANTITY } from '../../../shared/core/index';
import { EditorShell } from '../editor';
import { useAccounts, useFinRead, type FinData } from '../fin-api';
import { runCosting } from './costs-api';

/* 月末算成本的窗口：先填系统算不出来的金额和对方科目。页签在 CostingTab.tsx。 */

type Texts = Record<string, string>;
/** 算成本前要准备的：期初、要人填的出入库、上次填的（重做时） */
type Requirements = FinData<'GET /finance/costing/requirements'>;
type Valuation = Requirements['valuations'][number];

/** 提交的内容：期初成本、要补金额或对方科目的出入库；没填的说清是哪一样。 */
function costingBody(period: string, data: Requirements, amounts: Texts, counters: Texts) {
  const { opening } = data;
  const needed = data.valuations.filter((v) => v.needsAmount || v.needsCounter);
  return {
    period,
    ...(data.done ? { redo: true, expectedVoucherId: data.voucherId ?? null } : {}),
    opening: opening.map((o) => {
      const text = amounts['s' + o.stockId];
      if (!text?.trim()) throw new Error('请填写期初成本：' + o.name);
      return { stockId: o.stockId, unit: o.unit, quantity: o.quantity, amount: toCents(text) };
    }),
    valuations: needed.map((v) => {
      const text = amounts[v.id];
      if (v.needsAmount && !text?.trim()) throw new Error('请填写入库金额：' + v.name);
      if (v.needsCounter && !counters[v.id]) throw new Error('请选择对方科目：' + v.name);
      return {
        movementId: v.id,
        unit: v.unit,
        amount: v.needsAmount ? toCents(text) : 0,
        ...(counters[v.id] ? { counterAccount: counters[v.id] } : {}),
        reason: '月末成本录入',
      };
    }),
  };
}

function OpeningTable({
  opening,
  amountInput,
}: {
  opening: Requirements['opening'];
  amountInput: (key: string, label: string) => ReactNode;
}) {
  return (
    <FormSection
      title="启用前已有的库存，期初值多少钱"
      hint="要和启用财务时填的原材料（1403）、库存商品（1405）期初一致，否则这两个科目的余额会对不上。"
      columns={1}
    >
      <div className="line-table fb-no-tail">
        <table>
          <thead>
            <tr>
              <th>库存品</th>
              <th className="num">数量</th>
              <th className="num">期初金额 / 元</th>
            </tr>
          </thead>
          <tbody>
            {opening.map((o) => (
              <tr key={o.stockId}>
                <td className="fb-cell-text">{o.name}</td>
                <td className="fb-cell-text fb-num">
                  {o.quantity / UNITS_PER_QUANTITY} {o.unit}
                </td>
                <td className="num fb-amount">{amountInput('s' + o.stockId, o.name + ' 期初金额')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </FormSection>
  );
}

function ValuationTable({
  needed,
  amountInput,
  counters,
  setCounter,
}: {
  needed: Valuation[];
  amountInput: (key: string, label: string) => ReactNode;
  counters: Texts;
  setCounter: (id: string, code: string) => void;
}) {
  const accounts = useAccounts();
  return (
    <FormSection
      title="要补金额或对方科目的出入库"
      hint="手工流水的对方科目默认是待处理财产损溢；冲销等查不到原成本的，要填金额并选对方科目，否则总账和库存对不上。"
      columns={1}
    >
      <div className="line-table fb-no-tail">
        <table>
          <thead>
            <tr>
              <th>日期</th>
              <th>库存品</th>
              <th className="num">数量</th>
              <th className="num">入库金额 / 元</th>
              <th>对方科目</th>
            </tr>
          </thead>
          <tbody>
            {needed.map((v) => (
              <tr key={v.id}>
                <td className="fb-cell-text">
                  {v.date}
                  {v.late && <small>跨期补登</small>}
                </td>
                <td className="fb-cell-text">
                  {v.name}
                  {v.notes && <small>{v.notes}</small>}
                </td>
                <td className="fb-cell-text fb-num">
                  {v.quantity / UNITS_PER_QUANTITY} {v.unit}
                </td>
                <td className="num fb-amount">
                  {v.needsAmount ? amountInput(v.id, v.name + ' 入库金额') : <span className="fb-muted">按平均价</span>}
                </td>
                <td>
                  {v.needsCounter ? (
                    <select
                      aria-label={v.name + ' 对方科目'}
                      value={counters[v.id] ?? ''}
                      onChange={(e) => setCounter(v.id, e.target.value)}
                    >
                      <option value="">请选择</option>
                      {accounts
                        .filter((a) => a.leaf && a.enabled)
                        .map((a) => (
                          <option key={a.code} value={a.code}>
                            {a.code} {a.name}
                          </option>
                        ))}
                    </select>
                  ) : (
                    <span className="fb-muted fb-cell-text">默认</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </FormSection>
  );
}

/**
 * 算成本前把系统算不出来的填上：启用月已有库存的期初成本、手工出入库和查不到原成本的冲销的金额与对方科目。
 * 已经算过的月份是“重做”：原来的成本凭证红冲（没记账的作废），以后月份算过的一起撤回，上次填的金额带出来。
 */
export default function CostingDialog({ period, close }: { period: string; close: () => void }) {
  const { data, error } = useFinRead(['GET /finance/costing/requirements', { query: { period } }]);
  const [amounts, setAmounts] = useState<Texts>({});
  const [counters, setCounters] = useState<Texts>({});
  const opening = data?.opening || [];
  const valuations = data?.valuations || [];
  const late = data?.late || [];
  const redo = !!data?.done;
  const needed = valuations.filter((v) => v.needsAmount || v.needsCounter);
  // 重做时把上次填的金额和对方科目带出来
  useEffect(() => {
    const previous = data?.previousValuations || [];
    const opened = data?.previousOpening || [];
    if (!previous.length && !opened.length) return;
    setAmounts((all) => ({
      ...Object.fromEntries(previous.map((p) => [p.movementId, centsInput(p.amount)])),
      ...Object.fromEntries(opened.map((o) => ['s' + o.stockId, centsInput(o.amount)])),
      ...all,
    }));
    setCounters((all) => ({
      ...Object.fromEntries(
        previous.flatMap((p) => (p.counterAccount ? [[p.movementId, p.counterAccount]] : [])),
      ),
      ...all,
    }));
  }, [data]);
  const submit = async () => {
    // 读到之前“计算”按钮是灰的（回车也提交不了），这里只防万一
    if (!data) throw new Error('还在读取这个月要填的内容，请稍候再点。');
    await runCosting(costingBody(period, data, amounts, counters));
    return period + (redo ? ' 成本已重做，原凭证已冲销，新凭证待记账。' : ' 成本已计算，凭证待记账。');
  };
  const amountInput = (key: string, label: string) => (
    <input
      aria-label={label}
      inputMode="decimal"
      value={amounts[key] ?? ''}
      onChange={(e) => setAmounts({ ...amounts, [key]: e.target.value })}
    />
  );
  return (
    <EditorShell
      title={(redo ? '重做 ' : '计算 ') + period + ' 成本'}
      size="lg"
      submitLabel={redo ? '重做' : '计算'}
      disabled={!data}
      note="算完生成待记账凭证，到凭证页记账后才算完成。"
      close={close}
      submit={submit}
    >
      <FormMessage>{error}</FormMessage>
      {!data ? (
        <Loading />
      ) : (
        <>
          {redo && (
            <FormMessage tone="warning">
              这个月已经算过成本。重做会把原来的成本凭证红字冲销（没记账的作废），以后月份算过的成本一起撤回要重算，再按现在的流水和费用重新生成。
            </FormMessage>
          )}
          {late.length > 0 && (
            <FormMessage tone="warning">
              有 {late.length} 笔跨期补登：日期在已算成本的月份、算完以后才登记的流水，这次作为跨期调整算进 {period}。
            </FormMessage>
          )}
          <FormMessage tone="info">
            月末加权平均。到货、完工的金额系统自己算，冲销送货单、完工单退回的库存按原出库成本冲回；下面只列算不出来、要你填的，填
            0 表示没有成本。
          </FormMessage>
          {!opening.length && !needed.length && (
            <p className="choice-list-empty">
              这个月没有要填的，直接点“{redo ? '重做' : '计算'}”。
            </p>
          )}
          {opening.length > 0 && <OpeningTable opening={opening} amountInput={amountInput} />}
          {needed.length > 0 && (
            <ValuationTable
              needed={needed}
              amountInput={amountInput}
              counters={counters}
              setCounter={(id, code) => setCounters({ ...counters, [id]: code })}
            />
          )}
        </>
      )}
    </EditorShell>
  );
}
