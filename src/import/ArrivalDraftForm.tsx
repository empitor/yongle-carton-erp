import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { DraftText } from './DraftUI';
import {
  convertArrivalUnit,
  matchingArrivalStock,
  blankArrivalLine,
} from '../../shared/arrival-draft';
import { sheetArea } from '../../shared/physical-flow';
import { quantityString, formatStockSize } from '../../shared/operations';
import DimensionUnitSelect from '../DimensionUnitSelect';
import Combobox from '../ui/Combobox';
export default function ArrivalDraftForm({
  value: v,
  data,
  locked,
  change,
}: {
  value: any;
  data: any;
  locked: boolean;
  change: (patch: any) => void;
}) {
  const [purchaseFilter, setPurchaseFilter] = useState('');
  const patch = (i: number, delta: any) =>
    change({ lines: v.lines.map((l: any, j: number) => (i === j ? { ...l, ...delta } : l)) });
  const item = (i: number, delta: any) => {
    const next = { ...v.lines[i].item, ...delta },
      old = v.lines[i];
    const stillStock = data.items.some(
      (s: any) => s.id === old.stockId && matchingArrivalStock(next, s),
    );
    const stillPurchase = data.purchases.some(
      (p: any) =>
        p.supplierId === v.supplierId &&
        p.lines.some(
          (l: any) =>
            l.id === old.purchaseLineId && matchingArrivalStock(next, { ...l, kind: 'raw' }),
        ),
    );
    patch(i, {
      item: next,
      stockId: stillStock ? old.stockId : null,
      purchaseLineId: stillPurchase ? old.purchaseLineId : null,
    });
  };
  const purchases = data.purchases.filter(
    (p: any) => p.supplierId === v.supplierId && p.baseStatus === '已订货' && !p.archived,
  );
  const text = (label: string, value: string, update: (s: string) => void) => (
    <DraftText label={label} field={{ value: value || '' }} locked={locked} change={update} />
  );
  return (
    <>
      <div className="oi-order-fields oi-arrival-header-fields">
        <label>
          供应商档案
          <Combobox
            ariaLabel="到货供应商"
            disabled={locked}
            placeholder="搜索供应商"
            value={v.supplierId ? String(v.supplierId) : ''}
            onChange={(id) => {
              setPurchaseFilter('');
              change({
                supplierId: Number(id) || null,
                lines: v.lines.map((l: any) => ({ ...l, purchaseLineId: null })),
              });
            }}
            options={[
              ...(v.supplierId && !data.suppliers.some((s: any) => s.id === v.supplierId)
                ? [{ value: String(v.supplierId), label: '供应商 #' + v.supplierId + '（历史档案）' }]
                : []),
              ...data.suppliers.map((s: any) => ({ value: String(s.id), label: s.name })),
            ]}
          />
        </label>
        <label>
          送货单号
          <input
            aria-label="供应商送货单号"
            disabled={locked}
            value={v.reference}
            placeholder="待确认"
            onChange={(e) => change({ reference: e.target.value })}
          />
        </label>
        <label>
          到货日期
          <input
            aria-label="到货日期"
            type="date"
            disabled={locked}
            value={v.date}
            onChange={(e) => change({ date: e.target.value })}
          />
        </label>
        <label>
          采购候选筛选
          <select
            aria-label="到货采购单筛选"
            disabled={locked}
            value={purchaseFilter}
            onChange={(e) => setPurchaseFilter(e.target.value)}
          >
            <option value="">该供应商全部待到货采购</option>
            {purchases.map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.number}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="oi-arrival-cards">
        {v.lines.map((l: any, i: number) => {
          const label = '纸板' + (i + 1);
          let area: string | null = null;
          try {
            area = sheetArea(l.item, l.quantity);
          } catch {}
          const matches = data.items.filter(
            (s: any) => matchingArrivalStock(l.item, s) && !s.archived,
          );
          const options = purchases
            .filter((p: any) => !purchaseFilter || String(p.id) === purchaseFilter)
            .flatMap((p: any) =>
              p.lines
                .filter(
                  (x: any) =>
                    x.unit === '张' &&
                    (x.receivedUnits < x.quantityUnits || x.id === l.purchaseLineId),
                )
                .map((x: any) => ({ ...x, orderNumber: p.number })),
            );
          const stockMismatch = !!l.stockId && !matches.some((s: any) => s.id === l.stockId);
          return (
            <article className="oi-arrival-line" key={i} aria-label={'第' + (i + 1) + '项纸板明细'}>
              <div className="oi-arrival-row">
                <span className="oi-arrival-index">{i + 1}</span>
                <label>
                  纸板名称{text(label + '名称', l.item.name, (value) => item(i, { name: value }))}
                </label>
                <label>
                  规格型号
                  {text(label + '规格型号', l.item.specification, (value) =>
                    item(i, { specification: value }),
                  )}
                </label>
                <label>
                  实收 / 张
                  <input
                    aria-label={label + '实收数量'}
                    disabled={locked}
                    inputMode="numeric"
                    value={l.quantity}
                    onChange={(e) => patch(i, { quantity: e.target.value })}
                  />
                </label>
                <label>
                  单价
                  <input
                    aria-label={label + '单价'}
                    disabled={locked}
                    inputMode="decimal"
                    value={l.unitPrice ?? ''}
                    onChange={(e) => patch(i, { unitPrice: e.target.value || null })}
                  />
                </label>
                <label>
                  计价
                  <select
                    aria-label={label + '计价依据'}
                    disabled={locked}
                    value={l.priceBasis || ''}
                    onChange={(e) => patch(i, { priceBasis: e.target.value || null })}
                  >
                    <option value="">待确认</option>
                    <option value="area">元 / 平方米</option>
                    <option value="quantity">元 / 张</option>
                  </select>
                </label>
                <div className="oi-arrival-area">
                  <small>面积</small>
                  <b>{area !== null ? area + ' m²' : '待确认'}</b>
                </div>
                {!locked && (
                  <button
                    className="oi-arrival-remove"
                    aria-label={'移除纸板' + (i + 1)}
                    title="移除这一项"
                    disabled={v.lines.length <= 1}
                    onClick={() =>
                      change({ lines: v.lines.filter((_: any, j: number) => j !== i) })
                    }
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
              <details className="oi-arrival-more" open={stockMismatch}>
                <summary className={stockMismatch || area === null ? 'needs-attention' : ''}>
                  {[
                    formatStockSize(l.item),
                    [l.item.material, l.item.flute].filter(Boolean).join(' / ') || '配纸待确认',
                    l.stockId ? '原材料 #' + l.stockId : '确认时新建档案',
                    l.purchaseLineId ? '已关联采购' : '未关联采购',
                  ].join(' · ')}
                  {stockMismatch ? ' · 档案与规格不一致' : ''}
                </summary>
                <div className="oi-arrival-more-grid">
                  <label className="oi-arrival-wide">
                    关联采购明细
                    <Combobox
                      ariaLabel={label + '匹配采购明细'}
                      disabled={locked}
                      placeholder="无采购单收货 / 人工选择"
                      value={l.purchaseLineId ? String(l.purchaseLineId) : ''}
                      onChange={(id) => {
                        const pl = options.find((x: any) => x.id === Number(id));
                        patch(i, {
                          purchaseLineId: pl?.id || null,
                          ...(pl?.stockItemId ? { stockId: pl.stockItemId } : {}),
                        });
                      }}
                      options={[
                        { value: '', label: '无采购单收货 / 人工选择' },
                        ...(l.purchaseLineId && !options.some((p: any) => p.id === l.purchaseLineId)
                          ? [
                              {
                                value: String(l.purchaseLineId),
                                label: '采购明细 #' + l.purchaseLineId + '（历史关联）',
                              },
                            ]
                          : []),
                        ...options.map((pl: any) => ({
                          value: String(pl.id),
                          label: pl.orderNumber + ' · ' + pl.name,
                          hint:
                            (pl.specification || formatStockSize(pl)) +
                            ' · 剩余' +
                            quantityString(pl.quantityUnits - pl.receivedUnits) +
                            '张',
                        })),
                      ]}
                    />
                  </label>
                  <label className="oi-arrival-wide">
                    原材料档案
                    <Combobox
                      ariaLabel={label + '匹配原材料档案'}
                      disabled={locked}
                      placeholder="确认时新建独立原材料档案"
                      value={l.stockId ? String(l.stockId) : ''}
                      onChange={(id) => patch(i, { stockId: Number(id) || null })}
                      options={[
                        { value: '', label: '确认时新建独立原材料档案' },
                        ...(stockMismatch
                          ? [{ value: String(l.stockId), label: '原材料 #' + l.stockId + '（请核对历史关联）' }]
                          : []),
                        ...matches.map((s: any) => ({
                          value: String(s.id),
                          label: s.name,
                          hint: s.specification || formatStockSize(s),
                        })),
                      ]}
                    />
                    {stockMismatch && (
                      <small className="oi-bad">所选档案与当前规格不一致，请重新核对。</small>
                    )}
                  </label>
                  <label>
                    材质 / 配纸
                    <input
                      aria-label={label + '材质'}
                      disabled={locked}
                      value={l.item.material}
                      onChange={(e) => item(i, { material: e.target.value })}
                    />
                  </label>
                  <label>
                    楞型
                    <input
                      aria-label={label + '楞型'}
                      disabled={locked}
                      value={l.item.flute}
                      onChange={(e) => item(i, { flute: e.target.value })}
                    />
                  </label>
                  {['length', 'width', 'height'].map((k, n) => (
                    <label key={k}>
                      {['长', '宽', '高（选填）'][n]}
                      <input
                        aria-label={label + ['长', '宽', '高'][n]}
                        disabled={locked}
                        type="number"
                        step="any"
                        value={l.item[k] ?? ''}
                        onChange={(e) =>
                          item(i, { [k]: e.target.value === '' ? null : Number(e.target.value) })
                        }
                      />
                    </label>
                  ))}
                  <label>
                    尺寸单位
                    <DimensionUnitSelect
                      label={label + '尺寸单位'}
                      unit={l.item.dimensionUnit}
                      hasValues={[l.item.length, l.item.width, l.item.height].some(
                        (x) => x !== null,
                      )}
                      disabled={locked}
                      onChange={(unit) => item(i, convertArrivalUnit(l.item, unit))}
                    />
                  </label>
                  <label>
                    原单张数
                    <input
                      aria-label={label + '原单数量'}
                      disabled={locked}
                      value={l.statedQuantity ?? ''}
                      onChange={(e) => patch(i, { statedQuantity: e.target.value || null })}
                    />
                  </label>
                  <label>
                    原单面积 / m²
                    <input
                      aria-label={label + '原单面积'}
                      disabled={locked}
                      value={l.statedArea ?? ''}
                      onChange={(e) => patch(i, { statedArea: e.target.value || null })}
                    />
                  </label>
                  <label className="oi-arrival-wide">
                    明细备注{text(label + '备注', l.item.notes, (value) => item(i, { notes: value }))}
                  </label>
                  <label className="oi-arrival-wide">
                    差异说明
                    <textarea
                      aria-label={label + '差异原因'}
                      disabled={locked}
                      value={l.differenceReason}
                      onChange={(e) => patch(i, { differenceReason: e.target.value })}
                    />
                  </label>
                </div>
              </details>
            </article>
          );
        })}
      </div>
      <div className="oi-arrival-add">
        {!locked && (
          <button onClick={() => change({ lines: [...v.lines, blankArrivalLine()] })}>
            <Plus size={14} />
            增加纸板明细
          </button>
        )}
      </div>
      <div className="oi-arrival-notes">
        <label>
          整单备注
          <textarea
            aria-label="到货整单备注"
            disabled={locked}
            value={v.notes}
            onChange={(e) => change({ notes: e.target.value })}
          />
        </label>
        {v.sourceId && (
          <a href={'/api/flow/sources/' + v.sourceId + '/file'} target="_blank" rel="noreferrer">
            查看保留的原始到货单
          </a>
        )}
      </div>
    </>
  );
}
