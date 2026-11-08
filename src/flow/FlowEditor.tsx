import { Plus } from 'lucide-react';
import { type FlowKind } from '../../shared/physical-flow';
import { quantityString, formatStockSize } from '../../shared/operations';
import { convertDimension, normalizedDimensions } from '../../shared/product-details';
import DeliveryStockPicker from '../operations/DeliveryStockPicker';
import { blankArrivalLine } from '../../shared/arrival-draft';
import Field from '../ui/Field';
import Select from './Select';
import { safeArea, safeAmount } from './FlowDetails';

export function FlowEditor({
  kind,
  value: v,
  change,
  data,
  createFinished,
}: {
  kind: FlowKind;
  value: any;
  change: (v: any) => void;
  data: any;
  createFinished: () => void;
}) {
  const patchLine = (i: number, patch: any) =>
    change({
      lines: v.lines.map((l: any, index: number) => (index === i ? { ...l, ...patch } : l)),
    });
  const patchMaterial = (i: number, patch: any) =>
    change({
      materials: v.materials.map((l: any, index: number) => (index === i ? { ...l, ...patch } : l)),
    });
  const raw = data.items.filter((s: any) => s.kind === 'raw' && s.unit === '张'),
    finished = data.items.filter((s: any) => s.kind === 'finished');
  return (
    <div className="flow-editor">
      <div className="op-form-grid">
        {(kind === 'task' || kind === 'delivery') && (
          <Field variant="flow" label={kind === 'task' ? '计划生产日期 *' : '计划送货日期 *'}>
            <input
              aria-label="计划日期"
              type="date"
              value={v.plannedDate || v.date}
              onChange={(e) => change({ plannedDate: e.target.value })}
            />
          </Field>
        )}
        {kind === 'task' && (
          <Field variant="flow" label="计划生产时间（选填）">
            <input
              type="time"
              value={v.plannedTime || ''}
              onChange={(e) => change({ plannedTime: e.target.value || null })}
            />
          </Field>
        )}
        {kind === 'arrival' && v.isPlan && (
          <>
            <Field variant="flow" label="预计到货日期 *">
              <input
                type="date"
                value={v.plannedDate || v.date}
                onChange={(e) => change({ plannedDate: e.target.value, date: e.target.value })}
              />
            </Field>
            <Field variant="flow" label="预计到货时间">
              <input
                type="time"
                value={v.plannedTime || ''}
                onChange={(e) => change({ plannedTime: e.target.value || null })}
              />
            </Field>
            <p className="flow-warning">
              到货计划不增加库存。实际收货时另行登记实际日期、数量及验收结果。
            </p>
          </>
        )}
        {!(kind === 'arrival' && v.isPlan) && (
          <Field
            variant="flow"
            label={
              kind === 'delivery'
                ? '实际送货日期（确认发货时生效） *'
                : kind === 'task'
                  ? '任务登记日期 *'
                  : kind === 'arrival'
                    ? '实际到货日期 *'
                    : '业务日期 *'
            }
          >
            <input type="date" value={v.date} onChange={(e) => change({ date: e.target.value })} />
          </Field>
        )}
        {kind === 'delivery' && (
          <>
            <Field variant="flow" label="预计送货时间">
              <input
                type="time"
                value={v.plannedTime || ''}
                onChange={(e) => change({ plannedTime: e.target.value || null })}
              />
            </Field>
            <Field variant="flow" label="实际送货时间（未知可留空）">
              <input
                type="time"
                value={v.actualTime || ''}
                onChange={(e) => change({ actualTime: e.target.value || null })}
              />
            </Field>
          </>
        )}
        {kind === 'arrival' && !v.isPlan && (
          <Field variant="flow" label="实际到货时间（未知可留空）">
            <input
              type="time"
              value={v.actualTime || ''}
              onChange={(e) => change({ actualTime: e.target.value || null })}
            />
          </Field>
        )}
        {kind === 'arrival' && (
          <>
            <Select
              label="供应商 *"
              value={v.supplierId}
              options={data.suppliers}
              onChange={(supplierId) =>
                change({
                  supplierId,
                  lines: v.lines.map((l: any) => ({ ...l, purchaseLineId: null })),
                })
              }
            />
            {!v.isPlan && (
              <Field variant="flow" label="供应商送货单号 / 到货批次 *">
                <input
                  value={v.reference}
                  onChange={(e) => change({ reference: e.target.value })}
                  maxLength={100}
                />
              </Field>
            )}
            {v.sourceId && (
              <p className="flow-warning">
                本草稿来自AI识别，必须逐项核对数量、单位与采购关联。原件会保留。
              </p>
            )}
          </>
        )}
        {kind === 'task' && (
          <>
            <Select
              label="产品 *"
              value={v.productId}
              options={data.products}
              onChange={(productId) => change({ productId, orderIds: [] })}
            />
            <Field variant="flow" label="计划生产数量 *">
              <input
                inputMode="decimal"
                value={v.quantity}
                onChange={(e) => change({ quantity: e.target.value })}
              />
            </Field>
            <Field variant="flow" label="成品计量单位 *">
              <input
                value={v.unit}
                onChange={(e) => change({ unit: e.target.value })}
                maxLength={20}
              />
            </Field>
            <Field variant="flow" label="关联客户订单（可多选，也可独立生产）" wide>
              <div className="flow-order-options">
                {data.orders
                  .filter(
                    (o: any) =>
                      ['已确认', '生产中', '待发货'].includes(o.status) &&
                      o.lines.some((l: any) => l.productId === v.productId),
                  )
                  .map((o: any) => (
                    <label key={o.id}>
                      <input
                        type="checkbox"
                        checked={v.orderIds.includes(o.id)}
                        onChange={(e) =>
                          change({
                            orderIds: e.target.checked
                              ? [...v.orderIds, o.id]
                              : v.orderIds.filter((id: number) => id !== o.id),
                          })
                        }
                      />
                      {o.number} · {o.customerName}
                    </label>
                  ))}
              </div>
            </Field>
          </>
        )}
        {kind === 'production' && (
          <>
            <Select
              label="关联生产任务（可独立登记）"
              value={v.taskId}
              options={data.tasks
                .filter((t: any) => t.status === 'confirmed')
                .map((t: any) => ({
                  ...t,
                  label:
                    t.number +
                    ' · ' +
                    data.products.find((p: any) => p.id === t.productId)?.name +
                    ' · 完工' +
                    t.completed +
                    '/' +
                    t.quantity +
                    t.unit,
                }))}
              onChange={(taskId) => {
                const t = data.tasks.find((t: any) => t.id === taskId);
                change({
                  taskId,
                  ...(t
                    ? {
                        productId: t.productId,
                        finishedStockId:
                          finished.find(
                            (s: any) => s.productId === t.productId && s.unit === t.unit,
                          )?.id || null,
                      }
                    : {}),
                });
              }}
            />
            <Select
              label="生产产品 *"
              value={v.productId}
              options={data.products}
              onChange={(productId) => change({ productId, taskId: null, finishedStockId: null })}
            />
            <Select
              label="入库成品档案 *"
              value={v.finishedStockId}
              options={finished
                .filter((s: any) => s.productId === v.productId)
                .map((s: any) => ({
                  ...s,
                  label:
                    s.name +
                    ' · ' +
                    (s.specification || formatStockSize(s)) +
                    ' · ' +
                    s.quantity +
                    s.unit,
                }))}
              onChange={(finishedStockId) => change({ finishedStockId })}
            />
            <div className="op-field">
              <span>尚无对应成品档案？</span>
              <button
                type="button"
                className="secondary"
                disabled={!v.productId}
                onClick={createFinished}
              >
                <Plus size={15} />
                新建成品库存档案（保留草稿）
              </button>
            </div>
            <Field
              variant="flow"
              label={
                '实际合格数量 * / ' +
                (finished.find((s: any) => s.id === v.finishedStockId)?.unit || '成品单位')
              }
            >
              <input
                value={v.goodQuantity}
                inputMode="decimal"
                onChange={(e) => change({ goodQuantity: e.target.value })}
              />
            </Field>
            <Field variant="flow" label="损耗报废数量 / 同成品单位">
              <input
                value={v.scrapQuantity}
                inputMode="decimal"
                onChange={(e) => change({ scrapQuantity: e.target.value })}
              />
            </Field>
            <Field variant="flow" label="实际操作人员 *">
              <input value={v.operator} onChange={(e) => change({ operator: e.target.value })} />
            </Field>
          </>
        )}
        {kind === 'delivery' && (
          <>
            <Select
              label="客户 *"
              value={v.customerId}
              options={data.customers}
              onChange={(customerId) => {
                const c = data.customers.find((c: any) => c.id === customerId);
                change({
                  customerId,
                  address: c?.address || '',
                  contact: c?.contact || '',
                  phone: c?.phone || '',
                  lines: v.lines
                    .filter((l: any) => l.stockId)
                    .map((l: any) => ({ ...l, orderId: null, orderLineId: null, quantity: '' })),
                });
              }}
            />
            <Field variant="flow" label="收货地址">
              <input value={v.address} onChange={(e) => change({ address: e.target.value })} />
            </Field>
            <Field variant="flow" label="收货联系人">
              <input value={v.contact} onChange={(e) => change({ contact: e.target.value })} />
            </Field>
            <Field variant="flow" label="联系电话">
              <input value={v.phone} onChange={(e) => change({ phone: e.target.value })} />
            </Field>
          </>
        )}
        <Field variant="flow" label="整单备注" wide>
          <textarea
            value={v.notes}
            onChange={(e) => change({ notes: e.target.value })}
            maxLength={2000}
          />
        </Field>
      </div>
      {kind === 'arrival' && (
        <>
          <h3>{v.isPlan ? '预计到货明细' : '实际收货明细'} · 纸板按张管理</h3>
          {v.lines.map((l: any, i: number) => (
            <section className="flow-line" key={i}>
              <div className="flow-line-head">
                <strong>纸板 {i + 1}</strong>
                <button
                  className="danger-text"
                  disabled={v.lines.length === 1}
                  onClick={() => change({ lines: v.lines.filter((_: any, j: number) => i !== j) })}
                >
                  移除明细
                </button>
              </div>
              <div className="op-form-grid">
                <Select
                  label="匹配采购明细（可不关联）"
                  value={l.purchaseLineId}
                  options={data.purchases
                    .filter((p: any) => p.supplierId === v.supplierId && p.baseStatus === '已订货')
                    .flatMap((p: any) =>
                      p.lines
                        .filter((x: any) => x.unit === '张' && x.receivedUnits < x.quantityUnits)
                        .map((x: any) => ({
                          ...x,
                          label:
                            (v.notes?.includes(p.number) ||
                            (l.item.dimensionUnit &&
                              x.material === l.item.material &&
                              x.flute === l.item.flute &&
                              JSON.stringify(normalizedDimensions(x)) ===
                                JSON.stringify(normalizedDimensions(l.item)))
                              ? '[建议匹配，请核对] '
                              : '') +
                            p.number +
                            ' · ' +
                            x.name +
                            ' · ' +
                            (x.specification || formatStockSize(x)) +
                            ' · 剩余' +
                            quantityString(x.quantityUnits - x.receivedUnits) +
                            '张',
                        })),
                    )}
                  empty="无采购单收货 / 请人工选择"
                  onChange={(purchaseLineId) => {
                    const p = data.purchases.find((p: any) =>
                        p.lines.some((x: any) => x.id === purchaseLineId),
                      ),
                      pl = p?.lines.find((x: any) => x.id === purchaseLineId);
                    patchLine(i, {
                      purchaseLineId,
                      ...(pl
                        ? {
                            stockId: pl.stockItemId,
                            item: v.sourceId ? l.item : { ...pl, unit: '张' },
                            unitPrice: v.sourceId ? l.unitPrice : pl.unitPrice,
                            priceBasis: v.sourceId ? l.priceBasis : pl.priceBasis || 'quantity',
                          }
                        : {}),
                    });
                  }}
                />
                <Select
                  label="入库档案（全部规格一致才可选已有）"
                  value={l.stockId}
                  options={raw.map((s: any) => ({
                    ...s,
                    label:
                      s.name +
                      ' · ' +
                      s.material +
                      ' ' +
                      s.flute +
                      ' · ' +
                      formatStockSize(s) +
                      ' · ' +
                      s.specification,
                  }))}
                  empty="确认时新建独立原材料档案"
                  onChange={(stockId) => {
                    const s = raw.find((x: any) => x.id === stockId);
                    patchLine(i, { stockId, ...(s ? { item: { ...s, unit: '张' } } : {}) });
                  }}
                />
                <Field variant="flow" label="纸板名称 *">
                  <input
                    value={l.item.name}
                    onChange={(e) => patchLine(i, { item: { ...l.item, name: e.target.value } })}
                  />
                </Field>
                <Field variant="flow" label="规格说明">
                  <textarea
                    value={l.item.specification}
                    onChange={(e) =>
                      patchLine(i, { item: { ...l.item, specification: e.target.value } })
                    }
                  />
                </Field>
                <Field variant="flow" label="材质 / 配纸">
                  <input
                    value={l.item.material}
                    onChange={(e) =>
                      patchLine(i, { item: { ...l.item, material: e.target.value } })
                    }
                  />
                </Field>
                <Field variant="flow" label="楞型">
                  <input
                    value={l.item.flute}
                    onChange={(e) => patchLine(i, { item: { ...l.item, flute: e.target.value } })}
                  />
                </Field>
                <Field variant="flow" label="尺寸单位">
                  <select
                    value={l.item.dimensionUnit || ''}
                    onChange={(e) => {
                      const unit = e.target.value || null,
                        from = l.item.dimensionUnit;
                      patchLine(i, {
                        item: {
                          ...l.item,
                          dimensionUnit: unit,
                          ...(unit && from
                            ? {
                                length: convertDimension(l.item.length, from, unit as any),
                                width: convertDimension(l.item.width, from, unit as any),
                              }
                            : {}),
                        },
                      });
                    }}
                  >
                    <option value="">尚未确认</option>
                    <option value="mm">毫米 mm</option>
                    <option value="cm">厘米 cm</option>
                  </select>
                </Field>
                {(['length', 'width'] as const).map((k, j) => (
                  <Field
                    variant="flow"
                    key={k}
                    label={
                      (j === 0 ? '纸板长' : '纸板宽') + ' / ' + (l.item.dimensionUnit || '未知单位')
                    }
                  >
                    <input
                      type="number"
                      step="any"
                      value={l.item[k] ?? ''}
                      onChange={(e) =>
                        patchLine(i, {
                          item: {
                            ...l.item,
                            [k]: e.target.value === '' ? null : Number(e.target.value),
                          },
                        })
                      }
                    />
                  </Field>
                ))}
                <Field variant="flow" label={v.isPlan ? '预计到货数量 *' : '本批实际到货数量 *'}>
                  <input
                    value={l.quantity}
                    inputMode="numeric"
                    onChange={(e) =>
                      patchLine(i, {
                        quantity: e.target.value,
                        ...(l.acceptedQuantity === l.quantity &&
                        l.rejectedQuantity === '0' &&
                        l.stockedQuantity === l.quantity
                          ? { acceptedQuantity: e.target.value, stockedQuantity: e.target.value }
                          : {}),
                      })
                    }
                  />
                </Field>
                {!v.isPlan && (
                  <>
                    <Field variant="flow" label="验收合格数量（空白为全部合格）">
                      <input
                        inputMode="decimal"
                        value={l.acceptedQuantity ?? ''}
                        onChange={(e) => patchLine(i, { acceptedQuantity: e.target.value || null })}
                      />
                    </Field>
                    <Field variant="flow" label="不合格数量（空白按总数减合格数）">
                      <input
                        inputMode="decimal"
                        value={l.rejectedQuantity ?? ''}
                        onChange={(e) => patchLine(i, { rejectedQuantity: e.target.value || null })}
                      />
                    </Field>
                    <Field variant="flow" label="实际入库数量（空白为合格数量）">
                      <input
                        inputMode="decimal"
                        value={l.stockedQuantity ?? ''}
                        onChange={(e) => patchLine(i, { stockedQuantity: e.target.value || null })}
                      />
                    </Field>
                  </>
                )}
                <Field variant="flow" label="送货单标注张数（可留空）">
                  <input
                    value={l.statedQuantity ?? ''}
                    onChange={(e) => patchLine(i, { statedQuantity: e.target.value || null })}
                  />
                </Field>
                <Field variant="flow" label="送货单标注面积 / m²（可留空）">
                  <input
                    value={l.statedArea ?? ''}
                    onChange={(e) => patchLine(i, { statedArea: e.target.value || null })}
                  />
                </Field>
                <Field variant="flow" label="计价方式">
                  <select
                    value={l.priceBasis || ''}
                    onChange={(e) => patchLine(i, { priceBasis: e.target.value || null })}
                  >
                    <option value="">计价依据待确认</option>
                    <option value="area">平方米</option>
                    <option value="quantity">张数</option>
                  </select>
                </Field>
                <Field
                  variant="flow"
                  label={
                    '单价 / ' +
                    (l.priceBasis
                      ? '元每' + (l.priceBasis === 'area' ? '平方米' : '张')
                      : '计价依据待确认')
                  }
                >
                  <input
                    value={l.unitPrice ?? ''}
                    onChange={(e) => patchLine(i, { unitPrice: e.target.value || null })}
                  />
                </Field>
                <Field variant="flow" label="程序计算面积 / 金额">
                  <output>
                    {safeArea(l)} m² / {safeAmount(l)} 元
                  </output>
                </Field>
                <Field variant="flow" label="到货差异原因 / 无采购单说明" wide>
                  <textarea
                    value={l.differenceReason}
                    onChange={(e) => patchLine(i, { differenceReason: e.target.value })}
                  />
                </Field>
                <Field variant="flow" label="纸板备注" wide>
                  <textarea
                    value={l.item.notes}
                    onChange={(e) => patchLine(i, { item: { ...l.item, notes: e.target.value } })}
                  />
                </Field>
              </div>
            </section>
          ))}
          <button
            className="secondary"
            onClick={() => change({ lines: [...v.lines, blankArrivalLine()] })}
          >
            <Plus size={16} />
            增加纸板
          </button>
        </>
      )}
      {kind === 'production' && (
        <>
          <h3>实际领料与退料 · 以张登记</h3>
          {v.materials.map((m: any, i: number) => (
            <section className="flow-line" key={i}>
              <div className="op-form-grid">
                <Select
                  label="原材料品种 *"
                  value={m.stockId}
                  options={raw.map((s: any) => ({
                    ...s,
                    label:
                      s.name +
                      ' · ' +
                      s.material +
                      ' ' +
                      s.flute +
                      ' ' +
                      formatStockSize(s) +
                      ' · 库存' +
                      s.quantity +
                      '张',
                  }))}
                  onChange={(stockId) => patchMaterial(i, { stockId })}
                />
                <Field variant="flow" label="实际领用张数 *">
                  <input
                    value={m.issued}
                    onChange={(e) => patchMaterial(i, { issued: e.target.value })}
                  />
                </Field>
                <Field variant="flow" label="剩余退料张数">
                  <input
                    value={m.returned}
                    onChange={(e) => patchMaterial(i, { returned: e.target.value })}
                  />
                </Field>
                <button
                  className="danger-text"
                  disabled={v.materials.length === 1}
                  onClick={() =>
                    change({ materials: v.materials.filter((_: any, j: number) => i !== j) })
                  }
                >
                  移除材料
                </button>
              </div>
            </section>
          ))}
          <button
            className="secondary"
            onClick={() =>
              change({ materials: [...v.materials, { stockId: null, issued: '', returned: '0' }] })
            }
          >
            增加领料品种
          </button>
          <p className="sub">
            净耗用 = 实际领用 −
            退料。报废数量仅作为生产质量记录，材料损耗已体现在实际净耗用中，避免二次扣料。
          </p>
        </>
      )}
      {kind === 'delivery' && <DeliveryStockPicker value={v} data={data} change={change} />}
    </div>
  );
}
