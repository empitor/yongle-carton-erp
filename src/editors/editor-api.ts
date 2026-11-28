import type { OperationsApi, RecordsApi } from '../../shared/business/index';
import { call } from '../ui/index';

/**
 * 订单、客户、供应商、产品编辑窗的保存：没有 id 是新建（POST），有 id 是改这一条（PUT）。
 * 改的时候版本号取自表单：表单是打开窗口时的内容，带的是打开时读到的版本；窗口开着时别人改过，服务端回 409，
 * 不会拿页面重读到的新版本把别人的修改盖掉。
 * 客户、产品、订单按 shared/business/orders/records-api.ts 的接口表发，供应商按 operations-api.ts 的。
 */

const records = call<RecordsApi>(),
  operations = call<OperationsApi>();
/** 编辑窗的表单：新建时的正文，改的时候带着打开窗口时读到的版本号 */
type Form<Body> = Body & { version?: number };

/** 改一条：正文里要有打开时读到的版本号（服务端拿它做版本校验） */
function edited<B extends { version?: number }>(form: B): B & { version: number } {
  const { version } = form;
  if (version === undefined) throw new Error('改记录要带打开时读到的版本号，请关掉窗口重新打开再改。');
  return { ...form, version };
}

/** 订单：新建带上防重复请求号 requestId（编辑窗每开一次给一个，重试、连点只建一张） */
export const saveOrder = (id: number | undefined, form: Form<RecordsApi['POST /orders']['body']>, requestId: string) =>
  id
    ? records('PUT /orders/:id', { params: { id }, body: edited(form) })
    : records('POST /orders', { body: { ...form, requestId } });

/** 这张订单上订单明细只在这张订单里的产品（换客户时这些原客户产品会跟着改归新客户） */
export const soleOrderProducts = (id: number) => records('GET /orders/:id/sole-products', { params: { id } });

export const saveCustomer =(id: number | undefined, form: Form<RecordsApi['POST /customers']['body']>) =>
  id ? records('PUT /customers/:id', { params: { id }, body: edited(form) }) : records('POST /customers', { body: form });

/** 存好的供应商（带采购历史） */
export type SavedSupplier = OperationsApi['POST /suppliers']['response'];

export const saveSupplier = (id: number | undefined, form: Form<OperationsApi['POST /suppliers']['body']>) =>
  id
    ? operations('PUT /suppliers/:id', { params: { id }, body: edited(form) })
    : operations('POST /suppliers', { body: form });

export const saveProduct = (id: number | undefined, form: Form<RecordsApi['POST /products']['body']>) =>
  id ? records('PUT /products/:id', { params: { id }, body: edited(form) }) : records('POST /products', { body: form });
