import { z } from 'zod';
import { FormMessage, Facts, Hint, Section, yuan } from '../../ui/index';
import { FinSection } from '../layout';
import { FinList, col, mon, type Col } from '../table';
import { useFinRead, type FinData } from '../fin-api';
import { listInvoiceMatching } from './cash-api';

/** 开票对比一行：往来加还欠多少、已开票、来源事件快照（JSON 文字） */
type MatchingRow = FinData<'GET /finance/invoice-matching'>['rows'][number];
/** 来源事件快照里要的：单据的单号，盘点流水这类没有单号的用参考号（server/finance/source-snapshot.ts 的 doc） */
const snapshotDoc = z.object({
  doc: z.object({ number: z.string().optional(), reference: z.string().optional() }).nullish(),
});

/** 开票对比一行写哪张单据：快照里的单号或参考号，读不出来用往来的说明 */
function matchingNumber(r: MatchingRow) {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(r.source || 'null');
  } catch {
    return r.description;
  }
  const read = snapshotDoc.safeParse(snapshot);
  const doc = read.success ? read.data.doc : undefined;
  return doc?.number || doc?.reference || r.description;
}

/** 开票对比的列 */
const matchingColumns: Col<MatchingRow>[] = [
  col('number', '单据', { render: matchingNumber }),
  col('date', '单据日期'),
  // 和发票详情同屏，右侧详情打开时：1440 宽收已开票（= 单据金额 - 未开票，算得出来），
  // 1280 宽（区域约 600px）再收往来单位（单号认得出是哪张）。未收付意思接近“还欠”，不收
  col('party_name', '往来单位', { wrap: true, priority: 'mid' }),
  mon('amount_cents', '单据金额'),
  col('invoiced', '已开票', { money: true, render: (r) => yuan(r.invoiced ?? 0), priority: 'low' }),
  col('rest', '未开票', {
    money: true,
    render: (r) => yuan(r.amount_cents - (r.invoiced ?? 0)),
  }),
  mon('outstanding', '未收付'),
];

/** 开票对比：每张送货、到货单的金额，已开票多少、还没开多少。跟着发票的销项 / 进项走，默认收起。 */
export function MatchingSection({ kind }: { kind: 'receivable' | 'payable' }) {
  return (
    <FinSection
      id="matching"
      title="开票对比"
      note={kind === 'receivable' ? '送货单开了多少票' : '到货单收了多少票'}
      collapsed
    >
      <FinList
        list={listInvoiceMatching}
        label="开票对比"
        query={{ kind }}
        empty="没有要开票的单子"
        cols={matchingColumns}
      />
    </FinSection>
  );
}

const missing = (v: number | null, what: string) => (v == null ? what : yuan(v) + ' 元');

/** 税务底稿：内部参考，申报以税局系统为准。默认收起，导出在页头“更多”。 */
export function TaxSection({ period }: { period: string }) {
  const { data, error } = useFinRead(['GET /finance/tax', { query: { period } }]);
  return (
    <FinSection id="tax" title="税务底稿" note={period + ' 的增值税和附加税费'} collapsed>
      <FormMessage>{error}</FormMessage>
      <Hint>只是内部底稿，申报请以税局系统为准。</Hint>
      {data && (
        <div className="fin-tax-card">
          <Section title="增值税">
            <Facts
              items={[
                {
                  label: '纳税人',
                  value: data.taxpayer === 'small' ? '小规模' : data.taxpayer === 'general' ? '一般纳税人' : '未设置',
                },
                { label: '应纳增值税', value: missing(data.payable, '缺征收率') },
                { label: '销项税额', value: yuan(data.output) + ' 元' },
                { label: '进项税额', value: yuan(data.input) + ' 元' },
                { label: '进项转出', value: yuan(data.transfer) + ' 元' },
                { label: '上期留抵', value: yuan(data.carryIn) + ' 元' },
                { label: '本期留抵', value: yuan(data.carryOut) + ' 元' },
              ]}
            />
          </Section>
          <Section title="附加税费">
            <Facts
              items={[
                { label: '城建税', value: missing(data.urban, '缺税率') },
                { label: '教育费附加', value: missing(data.education, '缺税率') },
                { label: '地方教育附加', value: missing(data.localEducation, '缺税率') },
              ]}
            />
          </Section>
        </div>
      )}
    </FinSection>
  );
}
