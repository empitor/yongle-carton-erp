import { useState } from 'react';
import { FINISHED_UNIT, today } from '../../shared/core/index';
import { FormField, FormSection, useAuthState, useLoad } from '../ui/index';
import { readCatalog } from '../recordkit/catalog-api';
import { AddRow, CorrectionTable, CorrectQuantity } from './CorrectionParts';
import CorrectionShell from './CorrectionShell';
import MaterialInputs from './MaterialInputs';
import Select from './Select';
import { materialRows, newMaterialRow, productionCorrectionInput, productionHead, type ProductionHead } from './production-correction';
import { useCorrection, useCorrectionRows, type CorrectionPartProps } from './useCorrection';

/** 管理员那一栏要对照的产品、生产任务 */
type AdminCatalog = Awaited<ReturnType<typeof readCatalog<'products' | 'tasks'>>>;

/**
 * 更正完工单的几栏（超级管理员模式）：合格、报废，整张领纸板表（能加减行、换纸板）；
 * 本机管理员另能改完工日期、产品、挂哪张生产任务。外壳、核验和提交在 CorrectionShell、useCorrection。
 */
export default function ProductionCorrection(part: CorrectionPartProps<'production'>) {
  const doc = part.doc;
  const auth = useAuthState(),
    admin = !!auth?.actor?.localAdministrator;
  const [head, setHead] = useState(() => productionHead(doc));
  const { rows, setRows, patch } = useCorrectionRows(() => materialRows(doc), doc.materials);
  const catalog = useLoad(admin ? 'production-correction-admin' : 'production-correction', () =>
    readCatalog(admin ? ['items', 'products', 'tasks'] : ['items']),
  );
  const raw = (catalog.data?.items ?? []).filter((s) => s.kind === 'raw');
  const c = useCorrection(part, (reason) => productionCorrectionInput(doc, head, rows, reason));
  const busy = c.busy;
  const set = (p: Partial<ProductionHead>) => setHead((h) => ({ ...h, ...p }));
  const counts = [
    ['good', '合格', doc.goodQuantity],
    ['scrap', '报废', doc.scrapQuantity],
  ] as const;
  return (
    <CorrectionShell
      kind="production"
      subtitle={[doc.number, doc.productName, doc.date].filter(Boolean).join(' · ')}
      hint="整张没发生用“撤销这次完工”，数量或领料登记错了才用更正。"
      placeholder="例如：实际合格 900 只，原登记误填 1000 只"
      correction={c}
      loadError={catalog.error}
      close={part.close}
    >
      <FormSection title="合格、报废" columns={1}>
        <CorrectionTable first="项目">
          {counts.map(([k, t, now]) => (
            <tr key={k}>
              <td className="wh-cell-text">{t}</td>
              <td className="num wh-cell-text">{now + ' ' + FINISHED_UNIT}</td>
              <CorrectQuantity label={'正确' + t + '数量'} value={head[k]} unit={FINISHED_UNIT} busy={busy} change={(value) => set({ [k]: value })} />
            </tr>
          ))}
        </CorrectionTable>
      </FormSection>
      <FormSection
        title="领纸板"
        hint="写更正后的整张领料；净耗用 = 领用 − 退料"
        columns={1}
        extra={
          <AddRow busy={busy} add={() => setRows((l) => [...l, newMaterialRow()])}>
            加一种纸板
          </AddRow>
        }
      >
        <MaterialInputs rows={rows} raw={raw} busy={busy} patch={patch} remove={(i) => setRows((l) => l.filter((_, j) => j !== i))} />
      </FormSection>
      {admin && <ProductionCorrectionAdmin head={head} set={set} catalog={catalog.data} />}
    </CorrectionShell>
  );
}

/** 只有本机管理员能改的一栏：完工日期、产品（换了就入新产品的成品库存）、挂哪张生产任务 */
function ProductionCorrectionAdmin(o: {
  head: ProductionHead;
  set: (p: Partial<ProductionHead>) => void;
  /** 还没读到时是 null；读到的只有库存品时没有这两份 */
  catalog: Partial<AdminCatalog> | null;
}) {
  const products = o.catalog?.products ?? [],
    tasks = (o.catalog?.tasks ?? []).filter((t) => t.status === 'confirmed' || t.id === o.head.taskId);
  return (
    <FormSection title="管理员还能改" hint="改了这里的内容也是撤销原单、另出一张更正后的完工单" columns={2}>
      <FormField label="完工日期">
        <input
          type="date"
          aria-label="更正后的完工日期"
          max={today()}
          value={o.head.date}
          onChange={(e) => o.set({ date: e.currentTarget.value })}
        />
      </FormField>
      <Select
        label="产品"
        value={o.head.productId}
        options={products}
        onChange={(productId) => o.set({ productId, taskId: null })}
      />
      <Select
        label="生产任务"
        span="full"
        empty="不挂任务"
        value={o.head.taskId}
        options={tasks.map((t) => ({
          ...t,
          label: [t.number, products.find((p) => p.id === t.productId)?.name].filter(Boolean).join(' · '),
        }))}
        onChange={(taskId) => {
          const t = tasks.find((x) => x.id === taskId);
          o.set({ taskId, ...(t ? { productId: t.productId } : {}) });
        }}
      />
    </FormSection>
  );
}
