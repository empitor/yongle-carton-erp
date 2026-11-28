// 采购库存接口测试（purchasing-http.test.ts）的准备：起服务、建一套虚构档案和订单，发请求的几种写法。
// 回答按 shared/business 的视图结构（采购单、库存品、订货单、单据、删除影响）读；只取几项的用 readAs，别的项原样留着。内存库、虚构数据。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, one, rows } from '../../server/core/index.js';
import { OperationsService } from '../../server/operations/index.js';
import { FlowService } from '../../server/flow/index.js';
import {
  batchRowKey,
  flowViewSchema,
  impactRowSchema,
  orderBatchViewSchema,
  purchaseViewSchema,
  stockItemViewSchema,
  type PurchaseView,
} from '../../shared/business/index.js';
import { startHttp } from '../support/http-fixture.js';
import { readAs } from '../support/read-result.js';

export const password = 'Fictional-operations-password-123';

/** 回答的正文（JSON） */
export const json = async (r: Response): Promise<unknown> => r.json();
/** 出错的回答：给人看的说明、错误类别、附带的详情 */
export const problem = async (r: Response) =>
  readAs(await json(r), { message: z.string(), code: z.string().optional(), details: z.unknown().optional() });
/** 登记到货的回答（只读到货单） */
export const registered = (v: unknown) => readAs(v, { arrival: flowViewSchema('arrival') });

/** 供应商（接口表的 SupplierView 只有类型）：测试用到的几项，别的项留着，整份带回去 PUT 时不丢 */
const supplierShape = { id: z.number(), name: z.string(), version: z.number(), notes: z.string(), archived: z.boolean() };
const supplierList = z.array(z.looseObject({ purchaseHistory: z.array(z.object({ id: z.number() })) }));
/** 流水列表的一行（接口表的 MovementView 只有类型）：测试用到的几项 */
const movementList = z.array(
  z.object({
    source_kind: z.string(),
    actor_name: z.string(),
    purchaseNumber: z.string().nullable(),
    action: z.string(),
    delta: z.string(),
    after: z.string(),
  }),
);
const archiveResult = { results: z.array(z.object({ id: z.number(), success: z.boolean(), message: z.string() })) };
const moved = z.object({ movementId: z.string(), item: stockItemViewSchema });

type Http = Awaited<ReturnType<typeof startHttp>>;
type Row = { id: number; version: number };

/** 发请求：没有 body 是 GET；cookie 传 null 不带登录，csrf 传 false 不带页面凭证 */
const requester =
  (h: Http) =>
  (path: string, body?: unknown, method = 'POST', cookie: string | null = h.cookie, csrf = true) =>
    h.send(path, body, cookie ?? '', { method: body === undefined ? 'GET' : method, ...(csrf ? {} : { csrf: null }) });
type Req = ReturnType<typeof requester>;

/** 要成功的请求：不成功就让测试失败，回正文 */
const succeeder = (req: Req) => async (path: string, body?: unknown, method = 'POST') => {
  const r = await req(path, body, method),
    v = await json(r);
  assert.ok(r.ok, JSON.stringify({ path, status: r.status, answer: v }));
  return v;
};
type Good = ReturnType<typeof succeeder>;

/** 一个没有业务权限的账号（密码和管理员一样），登录后返回 cookie */
async function reader(h: Http) {
  const row = one(h.auth.db, rows.users.pick({ salt: true, password_hash: true }), 'SELECT * FROM users LIMIT 1');
  if (!row) throw new Error('测试数据：账号库里还没有管理员');
  h.auth.db
    .prepare('INSERT INTO users(id,name,salt,password_hash,permissions,role) VALUES(?,?,?,?,?,?)')
    .run(randomUUID(), '只读', row.salt, row.password_hash, '[]', 'admin');
  return h.login('只读', password);
}

/** 一套虚构档案：供应商、客户、产品和一张已确认的订单 */
async function seed(good: Good) {
  const supplier = readAs(await good('/suppliers', { name: '外购纸板供应商（虚构）' }), supplierShape),
    customer = readAs(await good('/customers', { name: '采购关联客户（虚构）' }), { id: z.number() }),
    product = readAs(await good('/products', { name: '成品纸箱（虚构）' }), { id: z.number() }),
    order = readAs(
      await good('/orders', {
        customerId: customer.id,
        orderDate: '2026-10-25',
        deliveryDate: '2026-11-05',
        status: '已确认',
        lines: [{ productId: product.id, quantity: 1000, unitPriceCents: 139, unitPriceExact: '1.3900', unit: '只' }],
        requestId: randomUUID(),
      }),
      { id: z.number(), number: z.string(), version: z.number() },
    );
  return { supplier, customer, product, order };
}

/** 一行外购纸板的采购明细，patch 盖在上面 */
const line = (patch: Record<string, unknown> = {}) => ({
  name: '外购三层纸板（虚构）',
  length: 1200,
  width: 900,
  dimensionUnit: 'mm',
  unit: '张',
  quantity: '1000',
  unitPrice: '1.3900',
  priceBasis: 'quantity',
  ...patch,
});

/** 手工出入库的请求体：按库存品现在的版本，patch 盖在上面 */
const move = (item: { version: number }, action: string, quantity: string, patch: Record<string, unknown> = {}) => ({
  expectedVersion: item.version,
  requestId: randomUUID(),
  action,
  quantity,
  date: '2026-10-26',
  notes: '经人工核对的虚构库存用途',
  acknowledged: true,
  ...patch,
});

/** 采购单里编号是 lineId 的那行明细 */
function lineOf(p: PurchaseView, lineId: number) {
  const found = p.lines.find((l) => l.id === lineId);
  if (!found) throw new Error('测试数据：采购单 ' + p.number + ' 没有明细 ' + lineId);
  return found;
}

/** 新建采购单、登记到货 */
function purchasing(req: Req, good: Good, base: { supplier: { id: number }; order: { id: number } }) {
  const purchase = async (patch: Record<string, unknown> = {}) =>
    purchaseViewSchema.parse(
      await good('/purchases', { supplierId: base.supplier.id, customerOrderId: base.order.id, orderDate: '2026-10-25', status: '已订货', lines: [line()], ...patch }),
    );
  // 登记到货只走订货单：先读采购单的订货单，按采购明细写的数量换成订货单的行键（batchRowKey）；返回 [地址, 请求体]
  const receive = async (
    p: PurchaseView,
    qty: string,
    reference = 'DN-' + randomUUID(),
    patch: { items?: { lineId: number; quantity: string }[] } = {},
  ): Promise<[string, unknown]> => {
    const batch = orderBatchViewSchema.parse(await json(await req('/order-batches/by-purchase/' + p.id)));
    const items = patch.items ?? [{ lineId: p.lines[0].id, quantity: qty }];
    return [
      '/order-batches/' + batch.id + '/receive',
      {
        expectedVersion: batch.version,
        requestId: randomUUID(),
        reference,
        date: '2026-10-26',
        rows: items.map((i) => ({ key: batchRowKey(lineOf(p, i.lineId)), quantity: i.quantity })),
      },
    ];
  };
  /** 登记成功，回登记后的采购单 */
  const received = async (p: PurchaseView, qty: string, reference?: string) => {
    await good(...(await receive(p, qty, reference)));
    return purchaseViewSchema.parse(await good('/purchases/' + p.id));
  };
  return { purchase, receive, received };
}

/** 读写采购单、供应商、库存品、流水，回答按视图结构读 */
function records(good: Good) {
  const at = (path: string, id?: number) => path + (id === undefined ? '' : '/' + id);
  return {
    readPurchase: async (id: number) => purchaseViewSchema.parse(await good('/purchases/' + id)),
    /** 整张保存采购单（PUT），或采购单的状态动作（action 是 cancel 这类，POST） */
    savePurchase: async (id: number, body: unknown, action?: string) =>
      purchaseViewSchema.parse(await good('/purchases/' + id + (action ? '/' + action : ''), body, action ? 'POST' : 'PUT')),
    purchases: async (query: string) => z.array(purchaseViewSchema).parse(await good('/purchases' + query)),
    /** 新建供应商（不给 id）或修改 */
    saveSupplier: async (body: unknown, id?: number) =>
      readAs(await good(at('/suppliers', id), body, id === undefined ? 'POST' : 'PUT'), supplierShape),
    suppliers: async (query: string) => supplierList.parse(await good('/suppliers' + query)),
    items: async (query = '') => z.array(stockItemViewSchema).parse(await good('/warehouse/items' + query)),
    readItem: async (id: number) => stockItemViewSchema.extend({ used: z.boolean() }).parse(await good('/warehouse/items/' + id)),
    /** 新建库存品（不给 id）或修改 */
    saveItem: async (body: unknown, id?: number) =>
      stockItemViewSchema.parse(await good(at('/warehouse/items', id), body, id === undefined ? 'POST' : 'PUT')),
    moveItem: async (item: { id: number }, body: unknown) => moved.parse(await good('/warehouse/items/' + item.id + '/move', body)),
    movements: async (query: string) => movementList.parse(await good('/warehouse/movements' + query)),
    arrivalRecords: async (purchaseId: number) =>
      z.array(z.unknown()).parse(await good('/flow/arrival-records?purchaseId=' + purchaseId)),
    previewDeletion: async (selection: unknown) =>
      readAs(await good('/deletions/preview', selection), { digest: z.string(), impact: z.array(impactRowSchema) }),
    /** 批量归档、恢复，回逐条的结果 */
    batch: async (entity: string, row: Row | Row[], action = 'archive') =>
      readAs(
        await good('/' + entity + '/batch', { action, acknowledged: true, items: [row].flat().map((r) => ({ id: r.id, version: r.version })) }),
        archiveResult,
      ),
  };
}

export async function purchasingFixture() {
  const store = new Store(':memory:'),
    h = await startHttp(store, { admin: { name: '采购仓库测试管理员', password } });
  const req = requester(h),
    good = succeeder(req),
    base = await seed(good);
  return {
    store,
    ops: new OperationsService(store),
    views: new FlowService(store).views,
    h,
    req,
    good,
    ...base,
    line,
    move,
    reader: () => reader(h),
    ...purchasing(req, good, base),
    ...records(good),
    async close() {
      await h.close();
      store.close();
    },
  };
}
