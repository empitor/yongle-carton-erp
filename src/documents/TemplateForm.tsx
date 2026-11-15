import { documentPapers, templatePaper, templateCopyLabels, type DocumentPaper, type DocumentTemplate } from '../../shared/documents/index';
import { FormField, FormSection } from '../ui/index';
import TemplateColumns from './TemplateColumns';

type Kind = 'purchase' | 'delivery';
type Edit = (patch: Partial<DocumentTemplate>) => void;
type SectionProps = { kind: Kind; template: DocumentTemplate; edit: Edit };

/** 下拉框选中的那项：只认列出的几种 */
const chosen = <T extends string>(options: readonly T[], value: string) => options.find((o) => o === value);
/** 纸张（照 documentPapers 的先后） */
const paperKeys = Object.keys(documentPapers).filter((k): k is DocumentPaper => k in documentPapers);
const fonts = ['宋体', '微软雅黑', '等线'] as const satisfies readonly DocumentTemplate['fontFamily'][];
/** 必填的几项 */
const requiredKeys = ['name', 'companyName', 'title'];

/** 模板里一行文字的几项 */
type TextKey =
  | 'name'
  | 'title'
  | 'companyName'
  | 'companyContact'
  | 'companyPhone'
  | 'companyAddress'
  | 'headerText'
  | 'footerText'
  | 'deliveryTerms'
  | 'acceptanceTerms'
  | 'paymentTerms';

/** 一行文字：名称、标题、公司资料、页眉页脚、条款 */
function TextInput(o: {
  template: DocumentTemplate;
  edit: Edit;
  field: TextKey;
  label: string;
  max: number;
  span?: 1 | 2 | 'full';
  hint?: string;
}) {
  const required = requiredKeys.includes(o.field);
  return (
    <FormField label={o.label} required={required} span={o.span} hint={o.hint}>
      <input
        maxLength={o.max}
        required={required}
        value={String(o.template[o.field] || '')}
        onChange={(e) => o.edit({ [o.field]: e.target.value })}
      />
    </FormField>
  );
}

/** 名称与公司资料 */
function CompanySection({ kind, template, edit }: SectionProps) {
  const text = { template, edit };
  return (
    <FormSection title="名称与公司资料">
      <TextInput {...text} field="name" label="模板名称" max={60} />
      <TextInput {...text} field="title" label="单据标题" max={30} />
      <TextInput {...text} field="companyName" label="我方工厂名称" max={100} span="full" />
      <TextInput {...text} field="companyContact" label="我方联系人" max={100} />
      <TextInput {...text} field="companyPhone" label="我方联系电话" max={50} />
      <TextInput
        {...text}
        field="companyAddress"
        label={kind === 'purchase' ? '默认交货地址' : '我方地址'}
        max={300}
        span="full"
      />
    </FormSection>
  );
}

/** 纸张与排版：纸张、方向、默认导出格式、字体、字号、行间距、表头底色、联次说明、商标、页眉页脚 */
function LayoutSection({ template, edit }: SectionProps) {
  const a4 = templatePaper(template) === 'a4';
  return (
    <FormSection title="纸张与排版" columns={2}>
      <FormField label="纸张">
        <select
          aria-label="纸张"
          value={templatePaper(template)}
          onChange={(e) => {
            const paper = chosen(paperKeys, e.target.value);
            if (paper) edit({ paper });
          }}
        >
          {paperKeys.map((k) => (
            <option key={k} value={k}>
              {documentPapers[k].label}
            </option>
          ))}
        </select>
      </FormField>
      <FormField label="纸张方向" hint={a4 ? undefined : '针式联单和 A5 随纸张固定'}>
        <select
          disabled={!a4}
          value={template.orientation}
          onChange={(e) => {
            const orientation = chosen(['landscape', 'portrait'] as const, e.target.value);
            if (orientation) edit({ orientation });
          }}
        >
          <option value="landscape">横向（明细列多）</option>
          <option value="portrait">纵向（明细列少）</option>
        </select>
      </FormField>
      <FormField label="默认导出格式">
        <select
          value={template.defaultFormat}
          onChange={(e) => {
            const defaultFormat = chosen(['docx', 'xlsx'] as const, e.target.value);
            if (defaultFormat) edit({ defaultFormat });
          }}
        >
          <option value="docx">Word (.docx)</option>
          <option value="xlsx">Excel (.xlsx)</option>
        </select>
      </FormField>
      <FormField label="字体">
        <select
          value={template.fontFamily}
          onChange={(e) => {
            const fontFamily = chosen(fonts, e.target.value);
            if (fontFamily) edit({ fontFamily });
          }}
        >
          {fonts.map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
      </FormField>
      <FormField label="正文字号">
        <select value={template.fontSize} onChange={(e) => edit({ fontSize: Number(e.target.value) })}>
          {[9, 10, 11, 12].map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </FormField>
      <FormField label="表格行间距">
        <select
          value={template.density}
          onChange={(e) => {
            const density = chosen(['normal', 'compact'] as const, e.target.value);
            if (density) edit({ density });
          }}
        >
          <option value="normal">标准</option>
          <option value="compact">紧凑</option>
        </select>
      </FormField>
      <FormField label="表头底色">
        <input className="adm-color" type="color" value={'#' + template.color} onChange={(e) => edit({ color: e.target.value.slice(1) })} />
      </FormField>
      <FormField label="联次说明" hint="印在右侧竖排，清空就不印">
        <input maxLength={80} value={templateCopyLabels(template)} onChange={(e) => edit({ copyLabels: e.target.value })} />
      </FormField>
      <label className="adm-check form-field span-full">
        <input type="checkbox" checked={template.showLogo} onChange={(e) => edit({ showLogo: e.target.checked })} />
        抬头显示公司商标
      </label>
      <TextInput template={template} edit={edit} field="headerText" label="页眉文字" max={300} span="full" />
      <TextInput template={template} edit={edit} field="footerText" label="页脚文字" max={300} span="full" hint="自动附页码" />
    </FormSection>
  );
}

/** 条款与签字：采购单的通用交货、验收、付款条件，统一附加备注，签字栏 */
function TermsSection({ kind, template, edit }: SectionProps) {
  const text = { template, edit };
  return (
    <FormSection
      title="条款与签字"
      columns={1}
      hint="只填实际采用的公司资料和通用条款；单笔订单的特殊约定写在采购备注里，模板不推测。"
    >
      {kind === 'purchase' && (
        <>
          <TextInput {...text} field="deliveryTerms" label="通用交货要求" max={500} />
          <TextInput {...text} field="acceptanceTerms" label="通用验收要求" max={500} />
          <TextInput {...text} field="paymentTerms" label="通用付款条件" max={500} />
        </>
      )}
      <FormField label="统一附加备注">
        <textarea rows={3} maxLength={1000} value={template.footerNotes} onChange={(e) => edit({ footerNotes: e.target.value })} />
      </FormField>
      <FormField label="签字栏" hint="1 至 3 项，用逗号分隔">
        <input
          value={template.signatures.join('，')}
          onChange={(e) => edit({ signatures: e.target.value.split(/[，,]/) })}
        />
      </FormField>
    </FormSection>
  );
}

/**
 * 单据模板的编辑表单：名称与公司资料、纸张与排版、明细列、条款与签字。改一项就交给 edit，
 * 保存、预览、读取在外面的设置页（DocumentTemplateSettings）。
 */
export default function TemplateForm({
  kind,
  template,
  columns,
  edit,
  resetColumns,
  disabled,
}: {
  kind: Kind;
  template: DocumentTemplate;
  columns: NonNullable<DocumentTemplate['columns']>;
  edit: Edit;
  resetColumns: () => void;
  disabled: boolean;
}) {
  const section = { kind, template, edit };
  return (
    <fieldset className="adm-fieldset" disabled={disabled}>
      <CompanySection {...section} />
      <LayoutSection {...section} />
      <TemplateColumns kind={kind} template={template} columns={columns} edit={edit} resetColumns={resetColumns} />
      <TermsSection {...section} />
    </fieldset>
  );
}
