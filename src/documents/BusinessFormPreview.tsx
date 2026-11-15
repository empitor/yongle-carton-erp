import { templateHeaderText, type BusinessForm } from '../../shared/documents/index';
import { splitFields, packInfo, totalParts, draftText, spacedTitle, templateInfoFields, totalLine } from '../../shared/documents/index';
import { BrandLogo } from '../ui/index';

/** 表头没给颜色时的底色 */
const DEFAULT_HEADER_COLOR = 'E8EEF0';
/** 明细里居中、靠右的几列 */
const centered = ['index', 'unit', 'flute'],
  rightAligned = ['quantity', 'amount', 'unitPrice'];
const align = (k: string) => (centered.includes(k) ? 'center' : rightAligned.includes(k) ? 'right' : undefined);

/** 每一张都一样的部分：版式按单据算好，逐张只换明细行和“合计见最后一张” */
type Layout = {
  f: BusinessForm;
  paper: string;
  perRow: number;
  keys: string[];
  color: string;
  fields: ReturnType<typeof splitFields>;
  infoRows: ReturnType<typeof packInfo>;
  total: ReturnType<typeof totalParts>;
  draft: string;
};

function layoutOf(f: BusinessForm): Layout {
  const paper = f.paper || 'a4',
    fields = splitFields(f),
    wide = paper.startsWith('continuous') || (paper === 'a4' && f.orientation !== 'portrait'),
    perRow = f.headers.length >= 6 && wide ? 3 : f.headers.length >= 4 ? 2 : 1,
    infoKeys = f.kind
      ? templateInfoFields(f.kind, f.templateSnapshot?.hiddenFields, f.templateSnapshot?.companyAddress)
      : fields.info.map(([k]) => k);
  const infoRows = packInfo(
    infoKeys.map((k): [string, string] => [k, fields.info.find(([name]) => name === k)?.[1] || '未填写']),
    perRow,
  );
  return {
    f,
    paper,
    perRow,
    keys: f.headers.map((_, i) => f.columnKeys?.[i] || ''),
    color: f.color || DEFAULT_HEADER_COLOR,
    fields,
    infoRows,
    total: totalParts(f),
    draft: draftText(f),
  };
}

/** 抬头：公司、标题（预览、样张时带一句说明）、单号和日期 */
function PaperHead({ layout: { f, fields, draft } }: { layout: Layout }) {
  return (
    <header className="paper-head">
      <div className="paper-company">
        {f.showLogo !== false && <BrandLogo size={36} />}
        <strong>{f.companyName}</strong>
      </div>
      <div className="paper-title">
        <h3 className={spacedTitle(f.title) ? 'spaced' : undefined}>{f.title}</h3>
        {draft && <em>{draft}</em>}
      </div>
      <div className="paper-number">
        <span>
          No. <b>{fields.number}</b>
        </span>
        {fields.date && <span>{fields.date[0] + '：' + fields.date[1]}</span>}
      </div>
    </header>
  );
}

/** 客户、供应商信息格 */
function PaperInfo({ layout: { infoRows, perRow } }: { layout: Layout }) {
  if (!infoRows.length) return null;
  return (
    <table className="paper-info">
      <tbody>
        {infoRows.map((row, i) => (
          <tr key={i}>
            {row.map(({ k, v, slots }) => (
              <td key={k} colSpan={slots} style={{ width: (100 * slots) / perRow + '%' }}>
                <span className="paper-info-label">{k}：</span>
                {v}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 明细表：表头、这一张的明细行（不够补空行）、合计、备注 */
function PaperLines({ layout, rows, last }: { layout: Layout; rows: string[][]; last: boolean }) {
  const { f, keys, color, total } = layout;
  const noteLabelSpan = Math.min(2, keys.length - 1) || 1;
  return (
    <div className="table-wrap">
      <table className="paper-lines">
        <thead style={{ backgroundColor: '#' + color, color: '#' + templateHeaderText(color) }}>
          <tr>
            {f.headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((v, j) => (
                <td key={j} style={{ textAlign: align(keys[j]) }}>
                  {v}
                </td>
              ))}
            </tr>
          ))}
          {total && (
            <tr className="paper-total">
              <td colSpan={keys.length}>{totalLine(total, last)}</td>
            </tr>
          )}
          <tr className="paper-notes">
            <th colSpan={noteLabelSpan}>备注</th>
            <td colSpan={keys.length - noteLabelSpan}>{f.notes}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** 一张纸：抬头、信息格、明细、条款、签字栏、页脚，针式联单右侧的联次说明 */
function PaperPage({ layout, rows, last }: { layout: Layout; rows: string[][]; last: boolean }) {
  const { f, paper, fields } = layout;
  return (
    <article
      className={'business-form-preview paper-' + paper + (paper === 'a4' ? ' paper-' + (f.orientation || 'landscape') : '')}
      style={{ fontFamily: f.fontFamily || '宋体', fontSize: (f.fontSize || 10) + 'pt' }}
    >
      <div className="paper-body">
        {f.headerText && <div className="paper-running-text">{f.headerText}</div>}
        <PaperHead layout={layout} />
        <PaperInfo layout={layout} />
        <PaperLines layout={layout} rows={rows} last={last} />
        {fields.terms.length > 0 && (
          <ol className="paper-terms">
            {fields.terms.map(([k, v]) => (
              <li key={k}>
                <b>{k}：</b>
                {v}
              </li>
            ))}
          </ol>
        )}
        <div className="paper-signatures">
          {f.signatures.map((s) => (
            <span key={s}>
              {s}：<i />
            </span>
          ))}
        </div>
        {(fields.own.length > 0 || f.footerText) && (
          <div className="paper-running-text">
            {[fields.own.map(([k, v]) => k + '：' + v).join('　'), f.footerText].filter(Boolean).join('　')}
          </div>
        )}
      </div>
      {f.copyLabels && <aside className="paper-copy-labels">{f.copyLabels}</aside>}
    </article>
  );
}

/**
 * 和导出的 Word / Excel 同一套固定版式：每张行数相同，货少留空行；超过一张续页，
 * 每张都有抬头、信息格、备注和签字栏，合计只写在最后一张。
 */
export default function BusinessFormPreview({ form: f }: { form: BusinessForm }) {
  const layout = layoutOf(f);
  const perPage = Math.max(1, f.rowsPerPage || f.rows.length || 1),
    pages = Array.from({ length: Math.max(1, Math.ceil(f.rows.length / perPage)) }, (_, p) => {
      const rows = f.rows.slice(p * perPage, (p + 1) * perPage);
      return [...rows, ...Array.from({ length: perPage - rows.length }, () => layout.keys.map(() => ''))];
    });
  return (
    <div className="business-form-pages">
      <p className="paper-capacity">
        每张固定 {perPage} 行明细{pages.length > 1 ? `，本单共 ${pages.length} 张` : ''}
      </p>
      {pages.map((pageRows, p) => (
        <PaperPage key={p} layout={layout} rows={pageRows} last={p === pages.length - 1} />
      ))}
    </div>
  );
}
