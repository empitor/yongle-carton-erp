import type { MarksApi } from '../../shared/business/index';
import { call, readAuthState, request, uploadFile } from '../ui/index';

/** 产品唛头的请求：列出、上传、编辑说明、删掉，和读原件。列出、改、删按接口表（shared/business/sales/mark-api.ts）发。 */

const marks = call<MarksApi>();

/** 挂在产品下的一份唛头 */
export type ProductMark = MarksApi['GET /products/:id/marks']['response'][number];

/** 唛头原件的地址（缩略图、点开看原件都用它） */
export const markFileUrl = (mark: { id: number }) => '/api/marks/' + mark.id + '/file';

export const listMarks = (productId: number) => marks('GET /products/:id/marks', { params: { id: productId } });

/** 一份一份传，哪份没传成就停在那份、说出文件名 */
export async function uploadMarks(productId: number, files: File[]) {
  const { csrf } = await readAuthState();
  for (const file of files)
    await uploadFile('/api/products/' + productId + '/marks/upload?name=' + encodeURIComponent(file.name), file, {
      token: csrf,
      contentType: file.type,
      failure: file.name + ' 上传失败',
    });
}

export const renameMark = (mark: { id: number; version: number }, title: string) =>
  marks('PUT /marks/:id', { params: { id: mark.id }, body: { title, expectedVersion: mark.version } });

export const removeMark = (mark: { id: number; version: number }) =>
  marks('DELETE /marks/:id', { params: { id: mark.id }, body: { expectedVersion: mark.version } });

/** 读原件（图片或 PDF） */
export const readMarkFile = (url: string) => request(url);
