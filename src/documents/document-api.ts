import type { z } from 'zod';
import type { DocumentTemplate, DocumentsApi, previewFileSchema } from '../../shared/documents/index';
import { call, readAuthState, request, throwIfFailed, signedOutMessage } from '../ui/index';

/**
 * 单据导出的请求：预览内容、模板设置、正式导出、交付确认、导出文件本身。
 * 订货单窗口（operations/OrderBatchDialog）和详情里的“单据导出”都走这里。
 * 回 JSON 的按接口表（shared/documents/documents-api.ts）发；回文件内容的三个（预览 Word 排版、测试样张、导出文件）照旧直接发。
 */

const documents = call<DocumentsApi>();

/**
 * 送货单要印出来的内容。shipping：待送货的按出库后印出来的样子（今天的实际送货日期）。
 * 采购订货单的预览按订货单读（previewDocumentBatch）。
 */
export const readDeliveryForm = (id: number, o: { templateId?: string; shipping?: boolean }) =>
  documents('GET /documents/preview/:kind/:id', {
    params: { kind: 'delivery', id },
    query: { templateId: o.templateId || undefined, shipping: o.shipping ? '1' : undefined },
  });

/** 几张采购单合成一份订货单的预览内容（按窗口里填的到货安排） */
export const previewDocumentBatch = (body: DocumentsApi['POST /documents/preview-batch']['body']) =>
  documents('POST /documents/preview-batch', { body });

export const readDocumentTemplates = () => documents('GET /documents/templates');

/** 保存全部模板和各类默认（带读到时的修订号） */
export const saveDocumentTemplates = (body: DocumentsApi['POST /documents/templates']['body']) =>
  documents('POST /documents/templates', { body });

/** 按当前（可能还没保存的）模板排一份虚构测试样张 */
export const previewDocumentTemplate = (template: DocumentTemplate) =>
  documents('POST /documents/templates/preview', { body: { template } });

/** 测试样张文件（Word 或 Excel），返回原始响应：要文件内容和类型 */
export async function documentTemplateSample(token: string, template: DocumentTemplate | undefined, format: 'docx' | 'xlsx') {
  const response = await request('/api/documents/templates/sample', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': token },
    body: JSON.stringify({ template, format }),
  });
  await throwIfFailed(response, '样张生成失败');
  return response;
}

/** 正式导出一份单据文件（markOrdered / markShipped 为真时文件交付后改状态） */
export const exportDocument = (body: DocumentsApi['POST /documents']['body']) => documents('POST /documents', { body });

/** 文件完整下载、校验过以后告诉服务端：这时才改业务状态 */
export const completeExport = (exportId: string, sha256: string) =>
  documents('POST /documents/:id/complete', { params: { id: exportId }, body: { sha256 } });

/**
 * 下载导出文件本身（地址由服务端给，调用方先核对只收 /api/documents/<编号>/file）：读失败统一读说明——
 * 网关错误页不报语法错误，会话失效回登录页。交回文件内容和类型。
 */
export async function downloadExportFile(url: string) {
  const response = await request(url, { cache: 'no-store' });
  await throwIfFailed(response, '文件下载失败。');
  return { bytes: await response.arrayBuffer(), type: response.headers.get('Content-Type') || '' };
}

/**
 * 预览 Word 排版：服务端按模板排一份 Word，直接拿文件内容给 WordFilePreview 看。
 * 走只读的预览接口，不占订货单号、不写导出记录、不改状态（正式导出才占号）。本地没登录不发。
 */
export async function previewWordFile(body: z.input<typeof previewFileSchema>) {
  const auth = await readAuthState();
  if (!auth.actor) throw new Error(signedOutMessage);
  const response = await request('/api/documents/preview-file', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-ERP-Auth-Token': auth.csrf },
    body: JSON.stringify(body),
  });
  await throwIfFailed(response, 'Word 预览生成失败。');
  // exportId 只给预览组件当刷新的键，不是导出记录
  return { bytes: await response.arrayBuffer(), exportId: crypto.randomUUID() };
}
