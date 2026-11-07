import { templateHeaderText } from '../shared/document-templates';
import {
  splitFields,
  packInfo,
  totalParts,
  draftText,
  spacedTitle,
  templateInfoFields,
  totalLine,
} from '../shared/document-layout';
import BrandLogo from './ui/BrandLogo';
/**
 * 和导出的 Word / Excel 同一套固定版式：每张行数相同，货少留空行；超过一张续页，
 * 每张都有抬头、信息格、备注和签字栏，合计只写在最后一张。
 */
export default function BusinessFormPreview({ form: f }: { form: any }) {
  const paper = f.paper || 'a4',
    { number, date, own, terms, info } = splitFields(f),
    wide = paper.startsWith('continuous') || (paper === 'a4' && f.orientation !== 'portrait'),
    perRow = f.headers.length >= 6 && wide ? 3 : f.headers.length >= 4 ? 2 : 1,
    infoKeys = f.kind
      ? templateInfoFields(
          f.kind,
          f.templateSnapshot?.hiddenFields,
          f.templateSnapshot?.companyAddress,
        )
      : info.map(([k]) => k),
    rows = packInfo(
      infoKeys.map((k: string) => [k, info.find(([name]) => name === k)?.[1] || '未填写']),
      perRow,
    ),
    total = totalParts(f),
    draft = draftText(f),
    keys: string[] = f.headers.map((_: string, i: number) => f.columnKeys?.[i] || ''),
    color = f.color || 'E8EEF0',
    align = (k: string) =>
      ['index', 'unit', 'flute'].includes(k)
        ? 'center'
        : ['quantity', 'amount', 'unitPrice'].includes(k)
          ? 'right'
          : undefined;
  const perPage = Math.max(1, f.rowsPerPage || f.rows.length || 1),
    pages = Array.from({ length: Math.max(1, Math.ceil(f.rows.length / perPage)) }, (_, p) => {
      const rows: string[][] = f.rows.slice(p * perPage, (p + 1) * perPage);
      return [...rows, ...Array.from({ length: perPage - rows.length }, () => keys.map(() => ''))];
    });
  return (
    <div className="business-form-pages">
      <p className="paper-capacity">
        每张固定 {perPage} 行明细{pages.length > 1 ? `，本单共 ${pages.length} 张` : ''}
      </p>
      {pages.map((pageRows, p) => {
        const last = p === pages.length - 1;
        return (
          <article
            key={p}
            className={
              'business-form-preview paper-' +
              paper +
              (paper === 'a4' ? ' paper-' + (f.orientation || 'landscape') : '')
            }
            style={{ fontFamily: f.fontFamily || '宋体', fontSize: (f.fontSize || 10) + 'pt' }}
          >
            <div className="paper-body">
              {f.headerText && <div className="paper-running-text">{f.headerText}</div>}
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
                    No. <b>{number}</b>
                  </span>
                  {date && <span>{date[0] + '：' + date[1]}</span>}
                </div>
              </header>
              {rows.length > 0 && (
                <table className="paper-info">
                  <tbody>
                    {rows.map((row, i) => (
                      <tr key={i}>
                        {row.map(({ k, v, slots }) => (
                          <td
                            key={k}
                            colSpan={slots}
                            style={{ width: (100 * slots) / perRow + '%' }}
                          >
                            <span className="paper-info-label">{k}：</span>
                            {v}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="table-wrap">
                <table className="paper-lines">
                  <thead
                    style={{ backgroundColor: '#' + color, color: '#' + templateHeaderText(color) }}
                  >
                    <tr>
                      {f.headers.map((h: string) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((r: string[], i: number) => (
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
                      <th colSpan={Math.min(2, keys.length - 1) || 1}>备注</th>
                      <td colSpan={keys.length - (Math.min(2, keys.length - 1) || 1)}>{f.notes}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {terms.length > 0 && (
                <ol className="paper-terms">
                  {terms.map(([k, v]) => (
                    <li key={k}>
                      <b>{k}：</b>
                      {v}
                    </li>
                  ))}
                </ol>
              )}
              <div className="paper-signatures">
                {f.signatures.map((s: string) => (
                  <span key={s}>
                    {s}：<i />
                  </span>
                ))}
              </div>
              {(own.length > 0 || f.footerText) && (
                <div className="paper-running-text">
                  {[own.map(([k, v]) => k + '：' + v).join('　'), f.footerText]
                    .filter(Boolean)
                    .join('　')}
                </div>
              )}
            </div>
            {f.copyLabels && <aside className="paper-copy-labels">{f.copyLabels}</aside>}
          </article>
        );
      })}
    </div>
  );
}
