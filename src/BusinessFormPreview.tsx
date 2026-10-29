import { templateHeaderText } from '../shared/document-templates';
export default function BusinessFormPreview({ form: f }: { form: any }) {
  return (
    <article
      className={'business-form-preview paper-' + (f.orientation || 'landscape')}
      style={{ fontFamily: f.fontFamily || '宋体', fontSize: (f.fontSize || 10) + 'pt' }}
    >
      {f.headerText && <div className="paper-running-text">{f.headerText}</div>}
      <h2>{f.companyName}</h2>
      <h3>
        {f.title}
        {f.sample ? ' · 测试样张 非正式' : f.draft ? ' · 计划单 非正式' : ''}
      </h3>
      <div className="paper-fields">
        {f.fields.map(([k, v]: any) => (
          <p key={k}>
            <strong>{k}：</strong>
            {v || '未填写'}
          </p>
        ))}
      </div>
      <div className="table-wrap">
        <table>
          <thead
            style={{
              backgroundColor: '#' + (f.color || 'E8EEF0'),
              color: '#' + templateHeaderText(f.color || 'E8EEF0'),
            }}
          >
            <tr>
              {f.headers.map((h: string) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {f.rows.map((r: string[], i: number) => (
              <tr key={i}>
                {r.map((v, j) => (
                  <td key={j}>{v}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {f.total !== undefined && <p className="paper-total">合计金额：{f.total ?? '待核价'} 元</p>}
      <p className="paper-notes">备注：{f.notes || '无'}</p>
      <div className="paper-signatures">
        {f.signatures.map((s: string) => (
          <span key={s}>{s}：________</span>
        ))}
      </div>
      {f.footerText && <div className="paper-running-text">{f.footerText}</div>}
    </article>
  );
}
