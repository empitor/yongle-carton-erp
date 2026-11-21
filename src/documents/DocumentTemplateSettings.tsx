import { useCallback, useEffect, useState } from 'react';
import { Eye, Save } from 'lucide-react';
import { canEditBusiness, useAuthState, useAction, useSaveFile } from '../ui/index';
import { documentTemplateSample, previewDocumentTemplate, readDocumentTemplates, saveDocumentTemplates } from './document-api';
import {
  defaultTemplateColumns,
  documentKinds,
  resetTemplateColumns,
  type BusinessForm,
  type DocumentKind,
  type DocumentTemplate,
  type DocumentTemplateState,
} from '../../shared/documents/index';
import { errorMessage } from '../../shared/core/index';
import BusinessFormPreview from './BusinessFormPreview';
import { WordFilePreview, type WordFile } from './export-file';
import { MenuItem, MoreMenu, Segmented } from '../ui/index';
import { FormMessage } from '../ui/index';
import TemplateForm from './TemplateForm';

/** 最多存几套模板 */
const MAX_TEMPLATES = 12;
/** 复制模板时原名称最多留几个字（后面接“ 副本”） */
const COPY_NAME_CHARS = 50;
/** 没登录时这一页说的话 */
const signedOutNotice = '请先登录管理账号。';

const cleanSignatures = <T extends { signatures: string[] }>(t: T): T => ({
  ...t,
  signatures: t.signatures.map((s) => s.trim()).filter(Boolean),
});

/** 当前编辑的模板：选中的，没选过用这类的默认，再没有用这类的第一套 */
const currentTemplate = (state: DocumentTemplateState | null, kind: DocumentKind, selected: string) =>
  state?.templates.find((t) => t.id === selected && t.kind === kind) ||
  state?.templates.find((t) => t.id === state.defaults[kind]) ||
  state?.templates.find((t) => t.kind === kind);

/** 模板设置页的状态和动作：读、改（只改待保存的内容）、复制、设默认、保存、样张 */
function useTemplateSettings() {
  const auth = useAuthState(),
    actorId = auth?.actor?.id;
  const [state, setState] = useState<DocumentTemplateState | null>(null),
    [kind, setKind] = useState<DocumentKind>('purchase'),
    [selected, setSelected] = useState(''),
    [loadError, setLoadError] = useState(''),
    [message, setMessage] = useState(''),
    [dirty, setDirty] = useState(false),
    [preview, setPreview] = useState<BusinessForm | null>(null),
    [word, setWord] = useState<WordFile | null>(null);
  const action = useAction(),
    save = useSaveFile();
  const clearPreview = useCallback(() => {
    setPreview(null);
    setWord(null);
  }, []);
  const load = useCallback(async () => {
    setState(await readDocumentTemplates());
    setDirty(false);
    clearPreview();
  }, [clearPreview]);
  // 换了登录的账号就重读
  useEffect(() => {
    if (actorId !== undefined) void load().catch((e: unknown) => setLoadError(errorMessage(e)));
    else setState(null);
  }, [actorId, load]);
  const template = currentTemplate(state, kind, selected);
  /** 改待保存的内容（点“保存模板设置”才写入），之前的预览作废 */
  const change = (update: (s: DocumentTemplateState) => DocumentTemplateState, note = '') => {
    setState((s) => s && update(s));
    setDirty(true);
    setMessage(note);
    clearPreview();
  };
  const work = (job: () => Promise<void>) => {
    setLoadError('');
    setMessage('');
    return action.run(job);
  };
  const sample = async (t: DocumentTemplate, format: 'docx' | 'xlsx', display = false) => {
    if (!auth) throw new Error(signedOutNotice);
    const response = await documentTemplateSample(auth.csrf, cleanSignatures(t), format);
    const bytes = await response.arrayBuffer();
    if (display) setWord({ bytes, exportId: crypto.randomUUID() });
    else {
      await save(bytes, response.headers.get('Content-Type') || '', '测试样张-' + t.title + '.' + format);
      setMessage('虚构测试样张已导出，业务记录和状态未改变。');
    }
  };
  return {
    auth, canEdit: canEditBusiness(auth), state, setState, kind, setKind, selected, setSelected, template,
    loadError, message, setMessage, dirty, setDirty, preview, setPreview, word, setWord, action, busy: action.busy,
    clearPreview, load, change, work, sample,
  };
}
type Settings = ReturnType<typeof useTemplateSettings>;

/** 顶部一排：分类、当前模板、设为本类默认，“更多”里复制为新模板、刷新 */
function TemplateBar({ s, state, template }: { s: Settings; state: DocumentTemplateState; template: DocumentTemplate }) {
  const { kind } = s;
  const copy = () => {
    const id = kind + '-' + crypto.randomUUID();
    s.change(
      (st) => ({
        ...st,
        templates: [...st.templates, { ...structuredClone(template), id, name: template.name.slice(0, COPY_NAME_CHARS) + ' 副本' }],
      }),
      '已复制为新模板，改好后点“保存模板设置”。',
    );
    s.setSelected(id);
  };
  return (
    <div className="adm-template-bar">
      <Segmented
        tabs
        label="单据模板分类"
        value={kind}
        onChange={(k) => {
          const next = documentKinds.find((d) => d === k);
          if (next) s.setKind(next);
          s.setSelected('');
          s.clearPreview();
        }}
        options={[
          ['purchase', '采购订货单'],
          ['delivery', '送货单'],
        ]}
      />
      <select
        aria-label="当前单据模板"
        value={template.id}
        onChange={(e) => {
          s.setSelected(e.target.value);
          s.clearPreview();
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
      <label className="adm-check">
        <input
          type="checkbox"
          checked={state.defaults[kind] === template.id}
          disabled={state.defaults[kind] === template.id || !s.canEdit}
          onChange={() => {
            s.setState({ ...state, defaults: { ...state.defaults, [kind]: template.id } });
            s.setDirty(true);
          }}
        />
        设为本类默认
      </label>
      <MoreMenu label="模板更多操作" text="更多">
        <MenuItem disabled={s.busy || !s.canEdit || state.templates.length >= MAX_TEMPLATES} onClick={copy}>
          复制为新模板
        </MenuItem>
        <MenuItem
          title={s.dirty ? '先保存或放弃修改再刷新' : '重新读取已保存的模板'}
          disabled={s.busy || s.dirty}
          onClick={() => void s.work(s.load)}
        >
          刷新
        </MenuItem>
      </MoreMenu>
    </div>
  );
}

/** 右边的虚构测试样张：刷新预览、预览 Word 排版，“导出测试文件”里下载测试 Word、Excel */
function TemplatePreviewPane({ s, template }: { s: Settings; template: DocumentTemplate }) {
  return (
    <section className="adm-template-preview" aria-label="虚构测试样张">
      <header>
        <div>
          <h3>虚构测试样张</h3>
          <p>按当前配置生成，保存前也能看。</p>
        </div>
        <button
          type="button"
          className="secondary"
          disabled={s.busy}
          onClick={() =>
            void s.work(async () => {
              s.setWord(null);
              s.setPreview(await previewDocumentTemplate(template));
            })
          }
        >
          <Eye size={14} aria-hidden="true" />
          刷新预览
        </button>
        <button type="button" className="secondary" disabled={s.busy} onClick={() => void s.work(() => s.sample(template, 'docx', true))}>
          预览Word排版
        </button>
        <MoreMenu label="导出测试文件">
          <MenuItem disabled={s.busy} onClick={() => void s.work(() => s.sample(template, 'docx'))}>
            下载测试Word
          </MenuItem>
          <MenuItem disabled={s.busy} onClick={() => void s.work(() => s.sample(template, 'xlsx'))}>
            下载测试Excel
          </MenuItem>
        </MoreMenu>
      </header>
      {s.word ? (
        <WordFilePreview file={s.word} />
      ) : s.preview ? (
        <div className="template-paper-scroll" role="region" aria-label="测试单据预览，可左右滚动" tabIndex={0}>
          <BusinessFormPreview form={s.preview} />
        </div>
      ) : (
        <div className="adm-template-empty">
          <Eye size={24} aria-hidden="true" />
          <strong>改好后点“刷新预览”</strong>
          <span>样张用虚构的产品、尺寸、单位和分批送货数量。</span>
        </div>
      )}
    </section>
  );
}

/**
 * 单据模板：左边按“名称与公司、纸张与排版、明细列、条款与签字”分节编辑，
 * 右边随时看虚构测试样张。只有一个主按钮“保存模板设置”，在底部固定的保存栏里；
 * 复制为新模板、刷新（放弃没保存的修改，重新读已保存的）在顶部的“更多”里。
 */
export default function DocumentTemplateSettings() {
  const s = useTemplateSettings(),
    { state, template, kind, busy } = s;
  const save = (current: DocumentTemplateState) =>
    void s.work(async () => {
      const result = await saveDocumentTemplates({
        // 签名栏末尾多打一个逗号会多出空项，保存前去掉，后端不收空签名。
        templates: current.templates.map(cleanSignatures),
        defaults: current.defaults,
        expectedRevision: current.revision,
      });
      s.setState(result);
      s.setDirty(false);
      s.setMessage('模板设置已保存，重启后继续生效。历史导出文件保持原样。');
    });
  return (
    <div className="adm-template">
      {!s.auth?.actor && <p className="adm-muted">{signedOutNotice}</p>}
      <FormMessage>{s.action.error || s.loadError}</FormMessage>
      <FormMessage tone="info">{s.message}</FormMessage>
      {state && template && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save(state);
          }}
        >
          <TemplateBar s={s} state={state} template={template} />
          <div className="adm-template-grid">
            <TemplateForm
              kind={kind}
              template={template}
              columns={template.columns || defaultTemplateColumns(kind)}
              edit={(patch) =>
                s.change((st) => ({ ...st, templates: st.templates.map((t) => (t.id === template.id ? { ...t, ...patch } : t)) }))
              }
              resetColumns={() =>
                s.change(
                  (st) => ({ ...st, templates: st.templates.map((t) => (t.id === template.id ? resetTemplateColumns(t) : t)) }),
                  '明细字段已恢复默认，保存后生效。',
                )
              }
              disabled={!s.canEdit || busy}
            />
            <TemplatePreviewPane s={s} template={template} />
          </div>
          <div className="adm-template-footer">
            <span>{s.dirty ? '有没保存的修改。保存后，之后人工和 AI 导出都用新设置。' : '已保存。已经导出的文件保持原样。'}</span>
            <button type="submit" className="primary" disabled={busy || !s.canEdit || !s.dirty}>
              <Save size={14} aria-hidden="true" />
              {busy ? '正在处理…' : '保存模板设置'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
