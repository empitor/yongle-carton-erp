import type { BusinessForm } from '../../shared/documents/index.js';
import { prepareRender } from './render-context.js';
import { renderDocx } from './render-docx.js';
import { renderXlsx } from './render-xlsx.js';
/** 按模板排好的单据出 Word 或 Excel 文件：先按版式检查每一格放不放得下（render-context.ts），再按格式画。 */
export async function renderBusinessForm(
  form: BusinessForm,
  format: 'docx' | 'xlsx',
): Promise<Buffer> {
  const ctx = prepareRender(form);
  return format === 'docx' ? renderDocx(ctx) : renderXlsx(ctx);
}
