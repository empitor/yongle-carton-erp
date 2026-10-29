import { useEffect, useState } from 'react';
import { ArrowUp, ArrowDown, Copy, Eye, Download, Save } from 'lucide-react';
import { managementRequest, useAuthState } from './session';
import { PageHeading } from './ui/ListLayout';
import {
  documentColumns,
  purchaseColumns,
  deliveryColumns,
  optionalDocumentFields,
  type DocumentTemplate,
  type DocumentTemplateState,
  type DocumentColumn,
} from '../shared/document-templates';
import BusinessFormPreview from './BusinessFormPreview';
import { WordFilePreview } from './BusinessExport';
export default function DocumentTemplateSettings() {
  const auth = useAuthState(),
    canEdit =
      !!auth?.actor &&
      (auth.actor.superAdminMode || auth.actor.permissions.includes('business:edit'));
  const [state, setState] = useState<DocumentTemplateState | null>(null),
    [kind, setKind] = useState<'purchase' | 'delivery'>('purchase'),
    [selected, setSelected] = useState('');
  const [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [preview, setPreview] = useState<any>(null),
    [word, setWord] = useState<any>(null);
  const load = async () => {
    const v = await managementRequest<DocumentTemplateState>('/documents/templates');
    setState(v);
    setDirty(false);
    setPreview(null);
    setWord(null);
  };
  useEffect(() => {
    if (auth?.actor) void load().catch((e) => setError(e.message));
    else setState(null);
  }, [auth?.actor?.id]);
  const template =
    state?.templates.find((t) => t.id === selected && t.kind === kind) ||
    state?.templates.find((t) => t.id === state.defaults[kind]) ||
    state?.templates.find((t) => t.kind === kind);
  const edit = (patch: Partial<DocumentTemplate>) => {
    setState(
      (s) =>
        s && {
          ...s,
          templates: s.templates.map((t) => (t.id === template?.id ? { ...t, ...patch } : t)),
        },
    );
    setDirty(true);
    setMessage('');
    setPreview(null);
    setWord(null);
  };
  const work = async (job: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await job();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const sample = async (format: 'docx' | 'xlsx', display = false) => {
    const response = await fetch('/api/documents/templates/sample', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth!.csrf },
      body: JSON.stringify({ template, format }),
    });
    if (!response.ok) throw new Error((await response.json()).message || '样张生成失败');
    const bytes = await response.arrayBuffer();
    if (display) setWord({ bytes, exportId: crypto.randomUUID() });
    else {
      const url = URL.createObjectURL(
        new Blob([bytes], { type: response.headers.get('Content-Type') || '' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = '测试样张-' + template!.title + '.' + format;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setMessage('虚构测试样张已导出，业务记录和状态未改变。');
    }
  };
  const columns = template?.columns || (kind === 'purchase' ? purchaseColumns : deliveryColumns);
  const move = (i: number, offset: number) => {
    const order = [...columns];
    [order[i], order[i + offset]] = [order[i + offset], order[i]];
    edit({ columns: order });
  };
  const textField = (key: keyof DocumentTemplate, label: string, max: number, wide = false) => (
    <label className={'field' + (wide ? ' wide' : '')}>
      <span>{label}</span>
      <input
        maxLength={max}
        required={['name', 'companyName', 'title'].includes(key)}
        value={String(template?.[key] || '')}
        onChange={(e) => edit({ [key]: e.target.value })}
      />
    </label>
  );
  return (
    <div className="template-settings">
      <PageHeading
        title="单据模板"
        description="人工和AI共用的正式单据样式。先调整配置，用虚构样张核对，再保存供后续导出使用。"
        actions={
          <button disabled={busy || dirty} onClick={() => void work(load)}>
            重新读取模板
          </button>
        }
      />
      {!auth?.actor && <p>请先登录管理账号。</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="success-banner">
          {message}
        </p>
      )}
      {state && template && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void work(async () => {
              const result = await managementRequest<DocumentTemplateState>(
                '/documents/templates',
                {
                  templates: state.templates,
                  defaults: state.defaults,
                  expectedRevision: state.revision,
                },
              );
              setState(result);
              setDirty(false);
              setMessage('模板设置已保存，重启后继续生效。历史导出文件保持原样。');
            });
          }}
        >
          <nav className="record-view-tabs" aria-label="单据模板分类">
            {(['purchase', 'delivery'] as const).map((k) => (
              <button
                type="button"
                key={k}
                className={kind === k ? 'selected' : ''}
                onClick={() => {
                  setKind(k);
                  setSelected('');
                  setPreview(null);
                  setWord(null);
                }}
              >
                {k === 'purchase' ? '采购订货单' : '送货单'}
              </button>
            ))}
          </nav>
          <div className="template-selection-row">
            <label className="field">
              <span>当前模板</span>
              <select
                aria-label="当前单据模板"
                value={template.id}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setPreview(null);
                  setWord(null);
                }}
              >
                {state.templates
                  .filter((t) => t.kind === kind)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.id === state.defaults[kind] ? '（默认）' : ''}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              disabled={busy || !canEdit || state.templates.length >= 12}
              onClick={() => {
                const id = kind + '-' + crypto.randomUUID();
                setState({
                  ...state,
                  templates: [
                    ...state.templates,
                    {
                      ...structuredClone(template),
                      id,
                      name: template.name.slice(0, 50) + ' 副本',
                    },
                  ],
                });
                setSelected(id);
                setDirty(true);
                setPreview(null);
                setWord(null);
              }}
            >
              <Copy size={15} />
              复制为新模板
            </button>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={state.defaults[kind] === template.id}
                disabled={state.defaults[kind] === template.id || !canEdit}
                onChange={() => {
                  setState({ ...state, defaults: { ...state.defaults, [kind]: template.id } });
                  setDirty(true);
                }}
              />
              设为本类默认模板
            </label>
            <span className="sub">
              已保存修订 {state.revision}
              {dirty ? ' · 有未保存修改' : ''}
            </span>
          </div>
          <div className="template-design-grid">
            <div className="template-config">
              <fieldset disabled={!canEdit || busy} className="form-section">
                <legend>名称与公司资料</legend>
                <div className="form-grid">
                  {textField('name', '模板名称 *', 60)}
                  {textField('title', '单据标题 *', 30)}
                  {textField('companyName', '我方工厂名称 *', 100, true)}
                  {textField('companyContact', '我方联系人（选填）', 100)}
                  {textField('companyPhone', '我方联系电话（选填）', 50)}
                  {textField(
                    'companyAddress',
                    kind === 'purchase' ? '默认交货地址（选填）' : '我方地址（选填）',
                    300,
                    true,
                  )}
                </div>
              </fieldset>
              <fieldset disabled={!canEdit || busy} className="form-section">
                <legend>A4与基本排版</legend>
                <div className="form-grid">
                  <label className="field">
                    <span>字体</span>
                    <select
                      value={template.fontFamily}
                      onChange={(e) => edit({ fontFamily: e.target.value as any })}
                    >
                      {['宋体', '微软雅黑', '等线'].map((f) => (
                        <option key={f}>{f}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>正文字号</span>
                    <select
                      value={template.fontSize}
                      onChange={(e) => edit({ fontSize: Number(e.target.value) })}
                    >
                      {[9, 10, 11, 12].map((n) => (
                        <option key={n}>{n}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>A4纸张方向</span>
                    <select
                      value={template.orientation}
                      onChange={(e) => edit({ orientation: e.target.value as any })}
                    >
                      <option value="landscape">横向 · 适合多列明细</option>
                      <option value="portrait">纵向 · 适合精简明细</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>表格行间距</span>
                    <select
                      value={template.density}
                      onChange={(e) => edit({ density: e.target.value as any })}
                    >
                      <option value="normal">标准</option>
                      <option value="compact">紧凑</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>表头底色</span>
                    <input
                      type="color"
                      value={'#' + template.color}
                      onChange={(e) => edit({ color: e.target.value.slice(1) })}
                    />
                  </label>
                  <label className="field">
                    <span>默认导出格式</span>
                    <select
                      value={template.defaultFormat}
                      onChange={(e) => edit({ defaultFormat: e.target.value as any })}
                    >
                      <option value="docx">Word (.docx)</option>
                      <option value="xlsx">Excel (.xlsx)</option>
                    </select>
                  </label>
                  {textField('headerText', '页眉文字（选填）', 300, true)}
                  {textField('footerText', '页脚文字（选填，自动附页码）', 300, true)}
                </div>
              </fieldset>
              <fieldset disabled={!canEdit || busy} className="form-section">
                <legend>明细字段与顺序</legend>
                <p className="help-text">
                  产品名称、数量与数量单位始终保留。尺寸单位保持原记录。上下箭头调整已显示列的顺序。
                </p>
                <div className="template-column-list">
                  {columns.map((key, i) => (
                    <div key={key}>
                      <label>
                        <input
                          type="checkbox"
                          checked
                          disabled={['name', 'unit', 'quantity'].includes(key)}
                          onChange={() => edit({ columns: columns.filter((c) => c !== key) })}
                        />
                        {documentColumns[key]}
                      </label>
                      <button
                        type="button"
                        aria-label={'上移' + documentColumns[key]}
                        disabled={!i}
                        onClick={() => move(i, -1)}
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button
                        type="button"
                        aria-label={'下移' + documentColumns[key]}
                        disabled={i === columns.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        <ArrowDown size={14} />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="template-hidden-columns">
                  {(Object.keys(documentColumns) as DocumentColumn[])
                    .filter((key) => !columns.includes(key))
                    .map((key) => (
                      <label key={key}>
                        <input
                          type="checkbox"
                          checked={false}
                          onChange={() => edit({ columns: [...columns, key] })}
                        />
                        {documentColumns[key]}
                      </label>
                    ))}
                </div>
                {kind === 'delivery' && (
                  <p className="help-text">
                    送货单默认不显示价格。可选价格列仅使用送货快照；历史批次没有价格快照时显示“未记录”。
                  </p>
                )}
                <details>
                  <summary>其他信息的显示与隐藏</summary>
                  <div className="template-hidden-columns">
                    {optionalDocumentFields.map((k) => (
                      <label key={k}>
                        <input
                          type="checkbox"
                          checked={!template.hiddenFields.includes(k)}
                          onChange={(e) =>
                            edit({
                              hiddenFields: e.target.checked
                                ? template.hiddenFields.filter((f) => f !== k)
                                : [...template.hiddenFields, k],
                            })
                          }
                        />
                        {k}
                      </label>
                    ))}
                  </div>
                </details>
              </fieldset>
              <fieldset disabled={!canEdit || busy} className="form-section">
                <legend>条款与签字</legend>
                <div className="form-grid">
                  {kind === 'purchase' && (
                    <>
                      {textField('deliveryTerms', '通用交货要求（选填）', 500, true)}
                      {textField('acceptanceTerms', '通用验收要求（选填）', 500, true)}
                      {textField('paymentTerms', '通用付款条件（选填）', 500, true)}
                    </>
                  )}
                  <label className="field wide">
                    <span>统一附加备注（选填）</span>
                    <textarea
                      rows={3}
                      maxLength={1000}
                      value={template.footerNotes}
                      onChange={(e) => edit({ footerNotes: e.target.value })}
                    />
                  </label>
                  <label className="field wide">
                    <span>签字栏（1至3项，中文逗号分隔）</span>
                    <input
                      value={template.signatures.join('，')}
                      onChange={(e) => edit({ signatures: e.target.value.split(/[，,]/) })}
                    />
                  </label>
                </div>
                <p className="help-text">
                  仅填写实际采用的公司资料与通用条款。单笔订单的特殊约定在采购备注中记录，不由模板推测。
                </p>
              </fieldset>
            </div>
            <section className="template-preview-panel">
              <div className="section-heading">
                <div>
                  <h2>虚构测试样张</h2>
                  <p className="sub">当前配置可直接预览，保存前也能导出测试文件。</p>
                </div>
              </div>
              <div className="template-preview-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void work(async () => {
                      setWord(null);
                      setPreview(
                        await managementRequest('/documents/templates/preview', { template }),
                      );
                    })
                  }
                >
                  <Eye size={15} />
                  刷新测试预览
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void work(() => sample('docx', true))}
                >
                  预览Word排版
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void work(() => sample('docx'))}
                >
                  <Download size={15} />
                  测试Word
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void work(() => sample('xlsx'))}
                >
                  测试Excel
                </button>
              </div>
              {word ? (
                <WordFilePreview file={word} />
              ) : preview ? (
                <div
                  className="template-paper-scroll"
                  role="region"
                  aria-label="测试单据预览，可左右滚动"
                  tabIndex={0}
                >
                  <BusinessFormPreview form={preview} />
                </div>
              ) : (
                <div className="template-preview-empty">
                  <Eye size={28} />
                  <strong>配置好后，点击“刷新测试预览”</strong>
                  <span>样张含虚构产品、尺寸、单位和分批送货数量。</span>
                </div>
              )}
            </section>
          </div>
          <div className="form-footer template-save-footer">
            <span>
              {dirty
                ? '有未保存修改。保存后用于后续人工及AI导出。'
                : '当前配置已保存，历史文件保留原模板快照。'}
            </span>
            <button type="submit" className="primary" disabled={busy || !canEdit || !dirty}>
              <Save size={16} />
              {busy ? '正在处理…' : '保存模板设置'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
