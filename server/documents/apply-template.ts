import {
  defaultTemplateColumns,
  documentColumns,
  templatePaper,
  templateCopyLabels,
  type DocumentTemplate,
} from '../../shared/documents/index.js';
import type { BusinessForm, TemplatedForm } from '../../shared/documents/index.js';
import { documentRowsPerPage } from './layout.js';
/** 把拼好的单据内容套上模板：列和顺序、隐藏的字段、我方资料和条款、纸张字号，再算出每张放几行。 */
export function applyDocumentTemplate(
  form: BusinessForm,
  template: DocumentTemplate,
  revision = 0,
): TemplatedForm {
  const keys = template.columns || defaultTemplateColumns(template.kind);
  const originalKeys = form.columnKeys || defaultTemplateColumns(template.kind);
  const hidden: readonly string[] = template.hiddenFields;
  const fields: [string, string][] = [...form.fields];
  if (template.companyContact || template.companyPhone)
    fields.push([
      '我方联系人',
      [template.companyContact, template.companyPhone].filter(Boolean).join(' / '),
    ]);
  if (template.kind === 'delivery' && template.companyAddress)
    fields.push(['我方地址', template.companyAddress]);
  if (template.kind === 'purchase') {
    if (template.companyAddress) fields.push(['交货地址', template.companyAddress]);
    if (template.deliveryTerms) fields.push(['交货要求', template.deliveryTerms]);
    if (template.acceptanceTerms) fields.push(['验收要求', template.acceptanceTerms]);
    if (template.paymentTerms) fields.push(['付款条件', template.paymentTerms]);
    fields.push(['税费说明', '本单未记录独立税费约定；如有约定，以本单备注为准，不自动推算税额。']);
  }
  const applied: TemplatedForm = {
    ...form,
    kind: template.kind,
    companyName: template.companyName,
    title: template.title + (form.title.includes('已取消') ? '（已取消，仅供存档）' : ''),
    fields: fields.filter(([k]) => !hidden.includes(k)),
    headers: keys.map((k) =>
      k === 'quantity'
        ? template.kind === 'purchase'
          ? '订购数量'
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
