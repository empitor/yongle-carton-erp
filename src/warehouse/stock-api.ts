import type { StockFlowApi } from '../../shared/business/index';
import { call } from '../ui/index';

/**
 * 库存品和库存流水的请求：库存品编辑窗、出入库 / 盘点窗口、流水详情都走这里（接口表 shared/business/flow/stock-flow-api.ts）。
 * 放在仓库这一层：流水详情在仓库页，库存品窗口（operations）在它上面。库存品列表走 recordkit 的 readCatalog。
 */

const stock = call<StockFlowApi>();

/** 新建库存品的表单；改的时候带着打开窗口时读到的版本号 */
type StockItemForm = StockFlowApi['POST /warehouse/items']['body'] & { version?: number };
/** 一笔手工出入库、盘点调整 */
type MoveBody = StockFlowApi['POST /warehouse/items/:id/move']['body'];

/** 一个库存品（带 used：有没有出入库记录或被单据引用） */
export const readStockItem = (id: number) => stock('GET /warehouse/items/:id', { params: { id } });

/** 这个产品已有的成品库存品（没有时回 null） */
export const readProductStock = (productId: number) =>
  stock('GET /warehouse/product-stock/:id', { params: { id: productId } });

/**
 * 存库存品：没有 id 是新建，有 id 是改这一个。改的时候版本号取自表单（打开窗口时读到的）：
 * 没带版本号就是程序没按打开时的内容保存，本地说清楚、不发（服务端也会拒）。
 */
export const saveStockItem = async (form: StockItemForm, id?: number) => {
  if (!id) return stock('POST /warehouse/items', { body: form });
  const { version } = form;
  if (version === undefined) throw new Error('改库存品要带打开时读到的版本号，请关掉窗口重新打开再改。');
  return stock('PUT /warehouse/items/:id', { params: { id }, body: { ...form, version } });
};

/** 手动入库、出库、盘点调整：一笔流水 */
export const moveStock = (item: { id: number }, body: MoveBody) =>
  stock('POST /warehouse/items/:id/move', { params: { id: item.id }, body });

/** 一条流水被管理员改写过的修订记录 */
export const readMovementRevisions = (id: string) =>
  stock('GET /warehouse/movements/:id/revisions', { params: { id } });
