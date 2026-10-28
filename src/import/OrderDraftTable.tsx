import { useState, useEffect } from 'react';
import { DraftText as WrappedText } from './DraftUI';
import {
  fieldLabels,
  headerFields,
  lineFields,
  type OrderDraft,
  type DraftField,
  type ImportWorkspaceView as Workspace,
} from '../../shared/order-draft';
import type { ImportMapping } from '../../shared/import-mapping';
import type { Customer, Product } from '../../shared/domain';
import DimensionUnitSelect from '../DimensionUnitSelect';
import {
  dimensionKeys,
  parseDimension,
  convertDimension,
  normalizeDimensionUnit,
} from '../../shared/product-details';
type Matches = {
  customers: Customer[];
  products: Product[];
  customerCandidates: { id: number; reason: string }[];
  productCandidates: Record<string, { id: number; reasons: string[] }[]>;
  duplicateOrders: { id: number; number: string; customerName: string }[];
};
export default function OrderDraftTable({
  workspace,
  draft,
  locked,
  change,
  onMapping,
}: {
  workspace: Workspace;
  draft: OrderDraft;
  locked: boolean;
  change: (k: string, v: string, line?: string) => void;
  onMapping: (m: ImportMapping) => void;
}) {
  const [matches, setMatches] = useState<Matches | null>(null),
    [matchError, setMatchError] = useState(''),
    [standard, setStandard] = useState<{
      issues: string[];
      notices?: string[];
      fields: any;
    } | null>(null),
    [dimensionError, setDimensionError] = useState('');
  const initial = () =>
    workspace.mapping || {
      customer: { mode: 'pending' as const },
      products: Object.fromEntries(draft.lines.map((l) => [l.id, { mode: 'pending' as const }])),
      roundingPolicy: 'exact-cents' as const,
    };
  const [mapping, setMapping] = useState<ImportMapping>(initial);
  useEffect(() => {
    let live = true;
    fetch('/api/ai/imports/' + workspace.id + '/standard-order', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && setStandard(d));
    return () => {
      live = false;
    };
  }, [workspace.id, workspace.revision]);
  useEffect(() => {
    setMapping(initial());
    fetch('/api/ai/imports/' + workspace.id + '/matches', { cache: 'no-store' })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.message);
        setMatches(d);
        setMatchError('');
      })
      .catch((e) => setMatchError(e.message));
  }, [workspace.id, workspace.revision]);
  function input(k: string, f: DraftField, line?: string) {
    if (k === 'dimensionUnit' && line) {
      const l = draft.lines.find((l) => l.id === line)!;
      return (
        <DimensionUnitSelect
          label={'明细' + (draft.lines.indexOf(l) + 1) + ' 尺寸单位'}
          unit={f.value}
          disabled={locked}
          hasValues={dimensionKeys.some((k) => !!l.fields[k].value)}
          onChange={(to) => {
            try {
              const from = normalizeDimensionUnit(f.value);
              const values =
                from && to
                  ? dimensionKeys.map(
                      (k) =>
                        [k, convertDimension(parseDimension(l.fields[k].value), from, to)] as const,
                    )
                  : [];
              for (const [k, v] of values) change(k, v === null ? '' : String(v), line);
              change('dimensionUnit', to || '', line);
              setDimensionError('');
            } catch {
              setDimensionError('当前尺寸不是有效正数，请修正或清空后再切换单位。');
            }
          }}
        />
      );
    }
    const label =
      (line ? '明细' + (draft.lines.findIndex((l) => l.id === line) + 1) + ' ' : '') +
      (fieldLabels as any)[k];
    return (
      <span className={'oi-field ' + (f.certainty === 'needs-review' ? 'uncertain' : '')}>
        {line && ['productName', 'specification', 'notes'].includes(k) ? (
          <WrappedText label={label} field={f} locked={locked} change={(v) => change(k, v, line)} />
        ) : (
          <input
            aria-label={label}
            title={f.note || ''}
            disabled={locked}
            value={f.value || ''}
            placeholder="待确认"
            onChange={(e) => change(k, e.target.value, line)}
          />
        )}
      </span>
    );
  }
  const selectChoice = (value: string, items: { id: number; version: number }[]) =>
    value === 'new'
      ? { mode: 'new' as const }
      : value
        ? {
            mode: 'existing' as const,
            id: Number(value),
            version: items.find((i) => i.id === Number(value))!.version,
          }
        : { mode: 'pending' as const };
  const choiceValue = (c: any) =>
    c?.mode === 'existing' ? String(c.id) : c?.mode === 'new' ? 'new' : '';
  return (
    <>
      <div className="oi-order-fields">
        {(['buyerName', 'purchaseOrderNumber', 'orderDate', 'deliveryDate'] as const).map((k) => (
          <label key={k}>
            {fieldLabels[k]}
            {input(k, draft.header[k])}
          </label>
        ))}
      </div>
      <div className="oi-customer-match">
        <span>客户档案</span>
        <select
          aria-label="客户匹配"
          disabled={locked || !matches}
          value={choiceValue(mapping.customer)}
          onChange={(e) =>
            setMapping((m) => ({
              ...m,
              customer: selectChoice(e.target.value, matches?.customers || []),
            }))
          }
        >
          <option value="">待确认，选择已有或新建</option>
          <option value="new">
            计划创建新客户：{draft.header.buyerName.value || '请先填名称'}
          </option>
          {matches?.customers.map((c) => (
            <option key={c.id} value={c.id}>
              {matches.customerCandidates.some((x) => x.id === c.id) ? '候选 · ' : ''}
              {c.name}
            </option>
          ))}
        </select>
        <small>相似名称仅作建议</small>
        <details>
          <summary>其他订单字段</summary>
          <div className="oi-extra-fields">
            {headerFields
              .filter(
                (k) =>
                  !['buyerName', 'purchaseOrderNumber', 'orderDate', 'deliveryDate'].includes(k),
              )
              .map((k) => (
                <label key={k}>
                  {fieldLabels[k]}
                  {input(k, draft.header[k])}
                </label>
              ))}
          </div>
        </details>
      </div>
      {matchError && <div className="oi-inline-error">档案候选读取失败：{matchError}</div>}
      {dimensionError && (
        <div className="oi-inline-error" role="alert">
          {dimensionError}
        </div>
      )}
      {!!workspace.evaluation?.issues.some((i) => i.path === 'products.optional') && (
        <details className="oi-product-notices">
          <summary>产品资料提醒（允许后补，不阻止导入）</summary>
          {[
            ...new Set(
              workspace.evaluation.issues
                .filter((i) => i.path === 'products.optional')
                .map((i) => i.message),
            ),
          ].map((s) => (
            <p key={s}>{s}</p>
          ))}
        </details>
      )}
      {!!standard?.issues.length && workspace.mapping && (
        <details className="oi-standard-check">
          <summary>标准订单资料仍需处理 {standard.issues.length} 项</summary>
          {[...new Set(standard.issues)].map((s, i) => (
            <p key={i}>{s}</p>
          ))}
        </details>
      )}
      {!!matches?.duplicateOrders.length && (
        <div className="oi-inline-error">
          发现相同采购单号：
          {matches.duplicateOrders.map((o) => o.number + '（' + o.customerName + '）').join('、')}
          ，请核对重复订单。
        </div>
      )}
      <div className="oi-lines-scroll">
        <table className="oi-lines">
          <thead>
            <tr>
              <th>产品名称</th>
              <th>规格型号</th>
              <th>备注</th>
              <th>数量 / 单位</th>
              <th>单价 / 元</th>
              <th>计算金额</th>
              <th>产品档案</th>
            </tr>
          </thead>
          <tbody>
            {draft.lines.map((l, i) => (
              <tr key={l.id}>
                <td>
                  <div className="oi-line-name">
                    <span>{i + 1}</span>
                    {input('productName', l.fields.productName, l.id)}
                  </div>
                  <details className="oi-line-details">
                    <summary>编码、配纸与其他字段</summary>
                    <div className="oi-extra-fields">
                      {lineFields
                        .filter(
                          (k) =>
                            ![
                              'productName',
                              'specification',
                              'notes',
                              'quantity',
                              'unit',
                              'unitPrice',
                            ].includes(k),
                        )
                        .map((k) => (
                          <label key={k}>
                            {fieldLabels[k]}
                            {input(k, l.fields[k], l.id)}
                          </label>
                        ))}
                    </div>
                  </details>
                </td>
                <td>{input('specification', l.fields.specification, l.id)}</td>
                <td>{input('notes', l.fields.notes, l.id)}</td>
                <td>
                  {input('quantity', l.fields.quantity, l.id)}
                  {input('unit', l.fields.unit, l.id)}
                </td>
                <td>
                  {input('unitPrice', l.fields.unitPrice, l.id)}
                  <small>保留四位精度</small>
                </td>
                <td className="oi-line-money">
                  {workspace.evaluation?.lineAmounts[l.id] || '待核对'}
                  <small>原文 {l.fields.statedAmount.value || '未提供'}</small>
                </td>
                <td>
                  <select
                    aria-label={'明细' + (i + 1) + ' 产品匹配'}
                    value={choiceValue(mapping.products[l.id])}
                    disabled={locked || !matches}
                    onChange={(e) =>
                      setMapping((m) => ({
                        ...m,
                        products: {
                          ...m.products,
                          [l.id]: selectChoice(e.target.value, matches?.products || []),
                        },
                      }))
                    }
                  >
                    <option value="">待确认</option>
                    <option value="new">计划创建新产品</option>
                    {matches?.products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {matches.productCandidates[l.id]?.some((x) => x.id === p.id)
                          ? '候选 · '
                          : ''}
                        {p.name}
                      </option>
                    ))}
                  </select>
                  {matches?.productCandidates[l.id]
                    ?.filter((c) => c.id === (mapping.products[l.id] as any)?.id)
                    .map((c) => (
                      <small key={c.id}>{c.reasons.join('、')}；须人工核对</small>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="oi-mapping-tools">
        <label>
          结算规则
          <select
            aria-label="金额结算规则"
            value={mapping.roundingPolicy}
            onChange={(e) =>
              setMapping((m) => ({
                ...m,
                roundingPolicy: e.target.value as ImportMapping['roundingPolicy'],
              }))
            }
          >
            <option value="exact-cents">精确到分，不自动舍入</option>
            <option value="half-up-cent">整单四舍五入到分（明确确认）</option>
          </select>
        </label>
        <button disabled={locked || !matches} onClick={() => onMapping(mapping)}>
          保存客户与产品选择
        </button>
        <span>仅保存草稿计划，不创建档案</span>
      </div>
    </>
  );
}
