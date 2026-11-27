import {
  defaultTemplateColumns,
  docField,
  documentColumns,
  documentFields,
  templatePaper,
  templateCopyLabels,
  type BusinessForm,
  type DocumentFieldId,
  type DocumentTemplate,
  type TemplatedForm,
} from '../../shared/documents/index.js';
import { fieldLabel } from '../../shared/core/index.js';
import { documentRowsPerPage } from './layout.js';

const TAX_TERMS_TEXT = '本单未记录独立税费约定；如有约定，以本单备注为准，不自动推算税额。';

/** 模板里配的我方资料和采购通用条款，按登记表允许的单据种类补进单据字段。 */
function templateExtraFields(template: DocumentTemplate): [string, string][] {
  const candidates: [DocumentFieldId, string][] = [
    ['companyContact', [template.companyContact, template.companyPhone].filter(Boolean).join(' / ')],
    ['companyAddress', template.companyAddress],
    ['purchaseDeliveryAddress', template.companyAddress],
    ['deliveryTerms', template.deliveryTerms],
    ['acceptanceTerms', template.acceptanceTerms],
    ['paymentTerms', template.paymentTerms],
    ['taxTerms', TAX_TERMS_TEXT],
  ];
  const allowed = new Set(documentFields.filter((f) => f.kinds.includes(template.kind)).map((f) => f.key));
  return candidates
    .map(([id, value]) => docField(id, value))
    .filter(([key, value]) => Boolean(value) && allowed.has(key));
}

/** 把拼好的单据内容套上模板：列和顺序、隐藏的字段、我方资料和条款、纸张字号，再算出每张放几行。 */
export function applyDocumentTemplate(
  form: BusinessForm,
  template: DocumentTemplate,
  revision = 0,
): TemplatedForm {
  const keys = template.columns || defaultTemplateColumns(template.kind);
  const originalKeys = form.columnKeys || defaultTemplateColumns(template.kind);
  const hidden: readonly string[] = template.hiddenFields;
  const fields: [string, string][] = [...form.fields, ...templateExtraFields(template)];
  const applied: TemplatedForm = {
    ...form,
    kind: template.kind,
    companyName: template.companyName,
    title: template.title + (form.title.includes('已取消') ? '（已取消，仅供存档）' : ''),
    fields: fields.filter(([k]) => !hidden.includes(k)),
    headers: keys.map((k) =>
      k === 'quantity'
        ? template.kind === 'purchase'
          ? fieldLabel('quantity', { record: 'purchases', parent: 'lines' })
          : '本批送货数量'
        : documentColumns[k],
    ),
    rows: form.rows.map((r, i) => {
      const data = {
        ...Object.fromEntries(originalKeys.map((k, j) => [k, r[j]])),
        ...form.lineData?.[i],
      };
      return keys.map((k) => data[k] || '');
    }),
    columnKeys: keys,
    signatures: template.signatures,
    notes: [form.notes, template.footerNotes].filter(Boolean).join('\n'),
    color: template.color,
    fontSize: template.fontSize,
    fontFamily: template.fontFamily,
    orientation: template.orientation,
    density: template.density,
    paper: templatePaper(template),
    copyLabels: templateCopyLabels(template),
    showLogo: template.showLogo,
    headerText: template.headerText,
    footerText: template.footerText,
    templateId: template.id,
    templateRevision: revision,
    defaultFormat: template.defaultFormat,
    templateSnapshot: template,
  };
  return { ...applied, rowsPerPage: documentRowsPerPage(applied) };
}
