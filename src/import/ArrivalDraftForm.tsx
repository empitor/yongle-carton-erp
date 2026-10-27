import { useState } from 'react';
import { Plus, Trash2, Link2, Layers3 } from 'lucide-react';
import { DraftText } from './DraftUI';
import {
  convertArrivalUnit,
  matchingArrivalStock,
  blankArrivalLine,
} from '../../shared/arrival-draft';
import { sheetArea } from '../../shared/physical-flow';
import { quantityString, formatStockSize } from '../../shared/operations';
import DimensionUnitSelect from '../DimensionUnitSelect';
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
          <select
            aria-label="到货供应商"
            disabled={locked}
            value={v.supplierId || ''}
            onChange={(e) => {
              setPurchaseFilter('');
              change({
                supplierId: Number(e.target.value) || null,
                lines: v.lines.map((l: any) => ({ ...l, purchaseLineId: null })),
              });
            }}
          >
            <option value="">请选择供应商</option>
            {v.supplierId && !data.suppliers.some((s: any) => s.id === v.supplierId) && (
              <option value={v.supplierId}>供应商 #{v.supplierId}（历史档案）</option>
            )}
            {data.suppliers.map((s: any) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
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
      <div className="oi-arrival-section-head">
        <strong>
          <Layers3 size={14} />
          纸板明细
        </strong>
        <span>{v.lines.length} 项 · 实收按张，面积按尺寸计算</span>
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
          return (
            <article className="oi-arrival-card" key={i} aria-label={'第' + (i + 1) + '项纸板明细'}>
              <header>
                <strong>
                  <span className="oi-arrival-index">{i + 1}</span>
                  {l.item.name || '待填写纸板名称'}
                </strong>
                <div>
                  <span className="oi-arrival-area">
                    {area ?? '面积待确认'}
                    {area !== null ? ' m²' : ''}
                  </span>
                  {!locked && (
                    <button
                      className="danger-quiet"
                      aria-label={'移除纸板' + (i + 1)}
                      disabled={v.lines.length <= 1}
                      onClick={() =>
                        change({ lines: v.lines.filter((_: any, j: number) => j !== i) })
                      }
                    >
                      <Trash2 size={13} />
                      移除
                    </button>
                  )}
                </div>
              </header>
              <div className="oi-arrival-card-fields">
                <label>
                  纸板名称{text(label + '名称', l.item.name, (value) => item(i, { name: value }))}
                </label>
                <label>
                  规格型号
                  {text(label + '规格型号', l.item.specification, (value) =>
                    item(i, { specification: value }),
                  )}
                </label>
              </div>
              <div className="oi-arrival-measures">
                <label>
                  实收数量 / 张
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
                  计价依据
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
              </div>
              <details className="oi-arrival-config">
                <summary>
                  尺寸与配纸 · {formatStockSize(l.item)} · {l.item.material || '材质待确认'} /{' '}
                  {l.item.flute || '楞型待确认'}
                </summary>
                <div className="oi-arrival-card-fields">
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
                </div>
                <div className="oi-arrival-dimensions">
                  {['length', 'width'].map((k, n) => (
                    <label key={k}>
                      {['长', '宽'][n]} / {l.item.dimensionUnit || '单位待确认'}
                      <input
                        aria-label={label + ['长', '宽'][n]}
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
                </div>
              </details>
              <details className="oi-arrival-match">
                <summary>
                  <Link2 size={13} />
                  <strong>档案与采购匹配</strong>
                  <span>{l.stockId ? '关联原材料 #' + l.stockId : '确认时新建独立原材料档案'}</span>
                </summary>
                <label>
                  关联采购明细
                  <select
                    aria-label={label + '匹配采购明细'}
                    disabled={locked}
                    value={l.purchaseLineId || ''}
                    onChange={(e) => {
                      const pl = options.find((x: any) => x.id === Number(e.target.value));
                      patch(i, {
                        purchaseLineId: pl?.id || null,
                        ...(pl?.stockItemId ? { stockId: pl.stockItemId } : {}),
                      });
                    }}
                  >
                    <option value="">无采购单收货 / 人工选择</option>
                    {l.purchaseLineId && !options.some((p: any) => p.id === l.purchaseLineId) && (
                      <option value={l.purchaseLineId}>
                        采购明细 #{l.purchaseLineId}（历史关联）
                      </option>
                    )}
                    {options.map((pl: any) => (
                      <option key={pl.id} value={pl.id}>
                        {pl.orderNumber} · {pl.name} · {pl.specification || formatStockSize(pl)} ·
                        剩余{quantityString(pl.quantityUnits - pl.receivedUnits)}张
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  原材料档案
                  <select
                    aria-label={label + '匹配原材料档案'}
                    disabled={locked}
                    value={l.stockId || ''}
                    onChange={(e) => patch(i, { stockId: Number(e.target.value) || null })}
                  >
                    <option value="">确认时新建独立原材料档案</option>
                    {l.stockId && !matches.some((s: any) => s.id === l.stockId) && (
                      <option value={l.stockId}>原材料 #{l.stockId}（请核对历史关联）</option>
                    )}
                    {matches.map((s: any) => (
                      <option key={s.id} value={s.id}>
                        {s.name} · {s.specification || formatStockSize(s)}
                      </option>
                    ))}
                  </select>
                </label>
                {l.stockId && !matches.some((s: any) => s.id === l.stockId) && (
                  <small className="oi-bad">所选档案与当前规格不一致，请重新核对。</small>
                )}
              </details>
              <div className="oi-arrival-card-fields">
                <label className="oi-arrival-wide">
                  明细备注{text(label + '备注', l.item.notes, (value) => item(i, { notes: value }))}
                </label>
              </div>
              <details className="oi-arrival-source-fields">
                <summary>
                  原单数据与差异说明 · 原文 {l.statedQuantity ?? '未知'} 张 /{' '}
                  {l.statedArea ?? '未知'} m²
                </summary>
                <div className="oi-arrival-card-fields">
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
                  <label>
                    高（选填）
                    <input
                      aria-label={label + '高'}
                      disabled={locked}
                      type="number"
                      step="any"
                      value={l.item.height ?? ''}
                      onChange={(e) =>
                        item(i, { height: e.target.value === '' ? null : Number(e.target.value) })
                      }
                    />
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
