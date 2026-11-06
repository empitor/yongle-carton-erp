import { Fragment, useState, useEffect } from 'react';
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
import { productCandidateDetails } from '../../shared/import-matching';
import { useImportMatching } from './useImportMatching';
import DimensionUnitSelect from '../DimensionUnitSelect';
import {
  dimensionKeys,
  parseDimension,
  convertDimension,
  normalizeDimensionUnit,
} from '../../shared/product-details';
export default function OrderDraftTable({
  workspace,
  draft,
  locked: externallyLocked,
  change,
  onMapping,
  onMappingPending,
  mappingError,
}: {
  workspace: Workspace;
  draft: OrderDraft;
  locked: boolean;
  change: (k: string, v: string, line?: string) => void;
  onMapping: (m: ImportMapping) => Promise<Workspace | null>;
  onMappingPending?: (pending: boolean) => void;
  mappingError?: string;
}) {
  const match = useImportMatching(workspace, draft, onMapping);
  const { matches, mapping, invalidated, customerResolution, candidates } = match;
  const locked = externallyLocked || match.saveState === 'saving';
  useEffect(
    () => onMappingPending?.(!matches || match.dirty || match.unresolved),
    [!!matches, match.dirty, match.unresolved, onMappingPending],
  );
  const [standard, setStandard] = useState<{
      issues: string[];
      notices?: string[];
      fields: any;
    } | null>(null),
    [dimensionError, setDimensionError] = useState('');
  useEffect(() => {
    let live = true;
    fetch('/api/ai/imports/' + workspace.id + '/standard-order', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && setStandard(d))
      .catch(() => live && setStandard(null));
    return () => {
      live = false;
    };
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
  const selectedCustomer =
    mapping.customer.mode === 'existing'
      ? matches?.customers.find((c) => c.id === (mapping.customer as any).id)
      : undefined;
  const customerUnavailable =
    !!matches &&
    mapping.customer.mode === 'existing' &&
    (!selectedCustomer || selectedCustomer.version !== mapping.customer.version);
  return (
    <>
      <div className="oi-match-savebar" aria-label="客户与产品选择保存">
        <div>
          <strong>客户与产品选择</strong>
        </div>
        <span
          role="status"
          aria-live="polite"
          className={'oi-match-save-state ' + (match.saveState === 'error' ? 'is-error' : '')}
        >
          {match.saveState === 'saving'
            ? '保存中…'
            : match.saveState === 'error'
              ? '保存失败 · 当前选择已保留'
              : match.dirty
                ? '有选择待保存'
                : workspace.mapping
                  ? '已保存'
                  : '尚未保存选择'}
        </span>
        <button
          type="button"
          className={match.dirty ? 'primary' : ''}
          disabled={locked || !matches || !match.dirty}
          onClick={() => void match.save()}
        >
          {match.saveState === 'saving' ? '保存中…' : '保存客户与产品选择'}
        </button>
        {match.saveState === 'error' && <p role="alert">{mappingError || match.saveError}</p>}
      </div>
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
            match.select(
              {
                ...mapping,
                customer: selectChoice(e.target.value, matches?.customers || []),
              },
              'customer',
            )
          }
        >
          <option value="">待确认，选择已有或新建</option>
          <option value="new">
            计划创建新客户：{draft.header.buyerName.value || '请先填名称'}
          </option>
          {matches?.customers.map((c) => (
            <option key={c.id} value={c.id}>
              {mapping.customer.mode === 'existing' && mapping.customer.id === c.id
                ? '已选择 · '
                : customerResolution?.candidates.some((x) => x.id === c.id)
                  ? '候选 · '
                  : ''}
              {c.name} · #{c.id}
              {c.contact ? ' · ' + c.contact : ''}
              {c.phone ? ' · ' + c.phone : ''}
            </option>
          ))}
        </select>
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
      <div className="oi-customer-candidates" aria-label="客户匹配状态">
        {invalidated.customer && mapping.customer.mode === 'pending' && (
          <p className="oi-match-invalid" role="alert">
            {invalidated.customer}
          </p>
        )}
        {mapping.customer.mode === 'existing' ? (
          <div className={customerUnavailable ? 'oi-match-invalid' : 'oi-match-success'}>
            <strong>
              {customerUnavailable ? '原客户选择已失效，请重新选择' : '已匹配到已有档案'}
            </strong>
            <span>
              {matches?.customers.find((c) => c.id === (mapping.customer as any).id)?.name ||
                (matches ? '档案待核对' : '正在读取档案…')}
            </span>
            {customerUnavailable && selectedCustomer && (
              <button
                type="button"
                disabled={locked}
                onClick={() =>
                  match.select(
                    {
                      ...mapping,
                      customer: {
                        mode: 'existing',
                        id: selectedCustomer.id,
                        version: selectedCustomer.version,
                      },
                    },
                    'customer',
                  )
                }
              >
                重新确认此客户
              </button>
            )}
            <details>
              <summary>查看客户档案</summary>
              {matches?.customers
                .filter((c) => c.id === (mapping.customer as any).id)
                .map((c) => (
                  <p key={c.id}>
                    档案 #{c.id} · 联系人 {c.contact || '未填写'} · 电话 {c.phone || '未填写'} ·
                    地址 {c.address || '未填写'}
                  </p>
                ))}
            </details>
          </div>
        ) : mapping.customer.mode === 'new' ? (
          <p>已选择计划新建客户；仅保存草稿计划。</p>
        ) : (
          <p>
            {customerResolution?.candidates.length
              ? '找到客户候选，等待确认'
              : !matches
                ? '正在读取客户候选…'
                : '未找到匹配档案，请核对客户名称或明确选择计划新建。'}
          </p>
        )}
        {mapping.customer.mode !== 'existing' &&
          customerResolution?.candidates.map((c) => (
            <div className="oi-match-candidate" key={c.id}>
              <div>
                <strong>
                  {c.name} · #{c.id}
                </strong>
                <small>
                  {[c.contact, c.phone, c.address].filter(Boolean).join(' · ') ||
                    '联系人资料未填写'}
                </small>
                <small>
                  {c.reason}
                  {c.archived ? ' · 已归档，请先恢复' : ''}
                </small>
              </div>
              <button
                type="button"
                aria-label={'选择客户候选 ' + c.id}
                disabled={locked || c.archived}
                onClick={() =>
                  match.select(
                    { ...mapping, customer: { mode: 'existing', id: c.id, version: c.version } },
                    'customer',
                  )
                }
              >
                选择此客户
              </button>
            </div>
          ))}
      </div>
      {match.readError && (
        <div className="oi-inline-error">档案候选读取失败：{match.readError}</div>
      )}
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
              <th>数量 / 单位</th>
              <th>单价 / 元</th>
              <th>计算金额</th>
            </tr>
          </thead>
          <tbody>
            {draft.lines.map((l, i) => (
              <Fragment key={l.id}>
                <tr>
                  <td>
                    <div className="oi-line-name">
                      <span>{i + 1}</span>
                      {input('productName', l.fields.productName, l.id)}
                    </div>
                    <details className="oi-line-details">
                      <summary>备注、编码、配纸等</summary>
                      <div className="oi-extra-fields">
                        {lineFields
                          .filter(
                            (k) =>
                              ![
                                'productName',
                                'specification',
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
                </tr>
                <tr className="oi-product-matching-row">
                  <td colSpan={5}>
                    <details
                      className="oi-product-matching-fold"
                      open={!['existing', 'new'].includes(mapping.products[l.id]?.mode)}
                    >
                      <summary
                        className={
                          ['existing', 'new'].includes(mapping.products[l.id]?.mode) ? '' : 'needs-attention'
                        }
                      >
                        产品档案 ·{' '}
                        {mapping.products[l.id]?.mode === 'existing'
                          ? '已匹配 ' +
                            (matches?.products.find(
                              (p) => p.id === (mapping.products[l.id] as any).id,
                            )?.name || '')
                          : mapping.products[l.id]?.mode === 'new'
                            ? '计划新建'
                            : '待确认' +
                              (candidates[l.id]?.length ? '（' + candidates[l.id].length + ' 个候选）' : '')}
                      </summary>
                    <div
                      className="oi-product-matching"
                      aria-label={'明细' + (i + 1) + ' 产品档案匹配'}
                    >
                      <strong className="oi-match-line-label">明细 {i + 1} · 产品档案</strong>
                      {invalidated.products[l.id] && mapping.products[l.id]?.mode === 'pending' && (
                        <p className="oi-match-invalid" role="alert">
                          {invalidated.products[l.id]}
                        </p>
                      )}
                      {mapping.products[l.id]?.mode === 'existing' ? (
                        (() => {
                          const product = matches?.products.find(
                            (p) => p.id === (mapping.products[l.id] as any).id,
                          );
                          const missing = product
                            ? [
                                !product.material?.trim() ? '材质' : '',
                                !product.flute?.trim() ? '楞型' : '',
                              ].filter(Boolean)
                            : [];
                          const unavailable =
                            !!matches &&
                            (!product ||
                              product.version !== (mapping.products[l.id] as any).version);
                          return (
                            <div
                              className={
                                unavailable
                                  ? 'oi-match-invalid'
                                  : missing.length
                                    ? 'oi-match-incomplete'
                                    : 'oi-match-success'
                              }
                            >
                              <strong>
                                {unavailable
                                  ? '原产品选择已失效，请重新选择'
                                  : missing.length
                                    ? '已匹配到已有产品，但档案资料不完整'
                                    : '已匹配到已有档案'}
                              </strong>
                              <small>
                                {product
                                  ? productCandidateDetails(product)
                                  : !matches
                                    ? '正在读取档案…'
                                    : '关联档案不可用，请重新选择'}
                              </small>
                              {!!missing.length && (
                                <small>档案资料不完整：缺少{missing.join(' / ')}（允许后补）</small>
                              )}
                              {unavailable && product && (
                                <button
                                  type="button"
                                  disabled={locked}
                                  onClick={() =>
                                    match.select(
                                      {
                                        ...mapping,
                                        products: {
                                          ...mapping.products,
                                          [l.id]: {
                                            mode: 'existing',
                                            id: product.id,
                                            version: product.version,
                                          },
                                        },
                                      },
                                      l.id,
                                    )
                                  }
                                >
                                  重新确认此产品
                                </button>
                              )}
                            </div>
                          );
                        })()
                      ) : mapping.products[l.id]?.mode === 'new' ? (
                        <p className="oi-match-planned">已选择计划新建产品；保存不建档</p>
                      ) : (
                        <div className="oi-match-pending">
                          <strong>
                            {candidates[l.id]?.length
                              ? '匹配候选 · 等待确认'
                              : !matches
                                ? '正在读取产品候选…'
                                : '未找到匹配档案'}
                          </strong>
                          {candidates[l.id]?.length > 1 && (
                            <small>有多个候选，请按规格、料号及差异核对。</small>
                          )}
                        </div>
                      )}
                      {mapping.products[l.id]?.mode !== 'existing' &&
                        mapping.products[l.id]?.mode !== 'new' &&
                        candidates[l.id]?.slice(0, 4).map((c) => {
                          const product = matches!.products.find((p) => p.id === c.id)!;
                          return (
                            <div
                              className={
                                'oi-match-candidate' + (c.recommended ? ' is-recommended' : '')
                              }
                              style={{
                                gridColumn: candidates[l.id].length === 1 ? '1 / -1' : undefined,
                              }}
                              key={c.id}
                            >
                              <div>
                                <strong>
                                  {c.name} · #{c.id}
                                </strong>
                                <small>{productCandidateDetails(product)}</small>
                                <small>{c.reasons.join('、')}</small>
                                {!!c.conflicts.length && (
                                  <small className="oi-match-invalid">
                                    需核对：{c.conflicts.join('、')}
                                  </small>
                                )}
                              </div>
                              <button
                                type="button"
                                disabled={locked}
                                aria-label={'明细' + (i + 1) + ' 确认产品候选 ' + c.id}
                                onClick={() =>
                                  match.select(
                                    {
                                      ...mapping,
                                      products: {
                                        ...mapping.products,
                                        [l.id]: {
                                          mode: 'existing',
                                          id: product.id,
                                          version: product.version,
                                        },
                                      },
                                    },
                                    l.id,
                                  )
                                }
                              >
                                确认此候选
                              </button>
                            </div>
                          );
                        })}
                      <select
                        aria-label={'明细' + (i + 1) + ' 产品匹配'}
                        value={
                          choiceValue(mapping.products[l.id]) ||
                          (() => {
                            const best = candidates[l.id]?.filter((c) => c.recommended) || [];
                            return best.length === 1 ? String(best[0].id) : '';
                          })()
                        }
                        disabled={locked || !matches}
                        onChange={(e) =>
                          match.select(
                            {
                              ...mapping,
                              products: {
                                ...mapping.products,
                                [l.id]: selectChoice(e.target.value, matches?.products || []),
                              },
                            },
                            l.id,
                          )
                        }
                      >
                        <option value="">待确认</option>
                        <option value="new">计划创建新产品</option>
                        {matches?.products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {mapping.products[l.id]?.mode === 'existing' &&
                            (mapping.products[l.id] as any).id === p.id
                              ? '已选择 · '
                              : candidates[l.id]?.some((x) => x.id === p.id)
                                ? '候选 · '
                                : ''}
                            {p.name} · #{p.id} · {productCandidateDetails(p)}
                          </option>
                        ))}
                      </select>
                      {mapping.products[l.id]?.mode === 'pending' &&
                        candidates[l.id]?.length > 4 && (
                          <small>
                            另有 {candidates[l.id].length - 4} 个候选，可在上方产品选择中查看。
                          </small>
                        )}
                    </div>
                    </details>
                  </td>
                </tr>
              </Fragment>
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
              match.select(
                {
                  ...mapping,
                  roundingPolicy: e.target.value as ImportMapping['roundingPolicy'],
                },
                'rounding',
              )
            }
          >
            <option value="exact-cents">精确到分，不自动舍入</option>
            <option value="half-up-cent">整单四舍五入到分（明确确认）</option>
          </select>
        </label>
        <span>仅保存草稿计划，不创建档案</span>
      </div>
    </>
  );
}
