import { useState } from 'react';
import { RAW_UNIT, fieldShort } from '../../shared/core/index';
import { FormSection, useAuthState, useLoad } from '../ui/index';
import { readCatalog } from '../recordkit/catalog-api';
import ArrivalCorrectionAdmin, { type AdminCatalog } from './ArrivalCorrectionAdmin';
import { CorrectionTable, CorrectQuantity } from './CorrectionParts';
import CorrectionShell from './CorrectionShell';
import { correctionHead, correctionInput, correctionRows, type CorrectionRow } from './arrival-correction';
import { useCorrection, useCorrectionRows, type CorrectionPartProps } from './useCorrection';

/** 验收三个数：叫法用窄处的简写（合格、拒收、入库） */
const inspection = (['acceptedQuantity', 'rejectedQuantity', 'stockedQuantity'] as const).map((k) => [k, fieldShort(k)] as const);
const noCatalog: AdminCatalog = { suppliers: [], items: [], purchases: [] };

/**
 * 更正到货单的几栏：按到货单取数，挂不挂采购单都能更正。业务账号改每行实到和验收数；
 * 本机管理员另有一栏（ArrivalCorrectionAdmin）。外壳、核验和提交在 CorrectionShell、useCorrection。
 */
export default function ArrivalCorrection(part: CorrectionPartProps<'arrival'>) {
  const arrival = part.doc;
  const auth = useAuthState(),
    admin = !!auth?.actor?.localAdministrator;
  const [head, setHead] = useState(() => correctionHead(arrival));
  const { rows, setRows, patch } = useCorrectionRows(() => correctionRows(arrival), arrival.lines);
  // 管理员那一栏要选供应商、库存品、采购明细
  const catalog = useLoad(admin ? 'arrival-correction' : null, () => readCatalog(['suppliers', 'items', 'purchases']));
  const c = useCorrection(part, (reason) => correctionInput(arrival, head, rows, reason));
  const busy = c.busy;
  const original = (r: CorrectionRow) => (r.index === undefined ? null : arrival.lines[r.index]);
  return (
    <CorrectionShell
      kind="arrival"
      subtitle={[arrival.number, arrival.supplierName, arrival.reference, arrival.date].filter(Boolean).join(' · ')}
      hint="货退回给供应商的用“采购退货”，登记错了才用更正。"
      placeholder="例如：实际到货 900 张，原登记误填 1000 张"
      correction={c}
      loadError={catalog.error}
      close={part.close}
    >
      <FormSection title="改成多少" hint="合格、拒收、入库不动时按原批次跟着算；原单和更正记录都会保存" columns={1}>
        <CorrectionTable
          first="纸板"
          extra={inspection.map(([, t]) => (
            <th key={t} className="num">
              {t}
            </th>
          ))}
        >
          {rows.map((r, i) => {
            const o = original(r),
              name = r.item?.name || '新加的纸板';
            return (
              <tr key={i}>
                <td className="wh-cell-text">
                  {name}
                  {/* 没关联采购的行采购单号是空的：不写“采购单”，和没规格的行一样写“—” */}
                  <small>{r.item?.specification || (o?.purchaseNumber ? '采购单 ' + o.purchaseNumber : '—')}</small>
                </td>
                <td className="num wh-cell-text">{o ? o.quantity + ' ' + (o.item.unit || RAW_UNIT) : '新加'}</td>
                <CorrectQuantity
                  label={name + '正确数量'}
                  value={r.quantity}
                  unit={RAW_UNIT}
                  busy={busy}
                  change={(quantity) => patch(i, { quantity })}
                />
                {inspection.map(([k, t]) => (
                  <td key={k} className="num">
                    <input
                      aria-label={name + '正确' + t + '数量'}
                      inputMode="decimal"
                      placeholder="跟着算"
                      disabled={busy}
                      // 没动过、数量也没改时显示原来的；改了数量还没动验收数的留空，由服务端按原批次算
                      value={r.touched || !o || r.quantity === String(o.quantity) ? r[k] : ''}
                      onChange={(e) =>
                        patch(i, {
                          // 改了数量后第一次动验收数：另两格从空的开始，不沿用原来的
                          ...(!r.touched && o && r.quantity !== String(o.quantity)
                            ? { acceptedQuantity: '', rejectedQuantity: '', stockedQuantity: '' }
                            : {}),
                          [k]: e.currentTarget.value,
                          touched: true,
                        })
                      }
                    />
                  </td>
                ))}
              </tr>
            );
          })}
        </CorrectionTable>
      </FormSection>
      {admin && (
        <ArrivalCorrectionAdmin
          head={head}
          setHead={(value) => setHead((h) => ({ ...h, ...value }))}
          rows={rows}
          setRows={setRows}
          patch={patch}
          catalog={catalog.data ?? noCatalog}
          busy={busy}
        />
      )}
    </CorrectionShell>
  );
}
