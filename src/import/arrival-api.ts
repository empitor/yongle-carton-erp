import { call } from '../ui/index';
import { createFlow, readFlow, updateFlow } from '../flow/index';
import { readCatalog } from '../recordkit/index';
import { readOrderBatch as readBatch, readOrderBatches, receiveOrderBatch as receiveBatch } from '../warehouse/index';
import type { ImportsApi } from '../../shared/import/index';

/**
 * 到货单类型要用的业务请求：对照的档案、已登记的到货单和原件识别记录、登记到货。
 * 单据、订货单的请求走单据流转（src/flow）、仓库（src/warehouse）的接口；原件识别记录是识别导入自己的地址（接口表 imports-api.ts）。
 */
const imports = call<ImportsApi>();

/** 到货识别要对照的档案：供应商、采购单、库存品、还没到齐的订货单 */
export const readArrivalCatalog = () =>
  Promise.all([readCatalog(['suppliers', 'purchases', 'items']), readOrderBatches()]).then(
    ([catalog, batches]) => ({ ...catalog, batches }),
  );
/** 到货识别对照的档案（readArrivalCatalog 的回答） */
export type ArrivalCatalog = Awaited<ReturnType<typeof readArrivalCatalog>>;

export const readArrivalDoc = (id: number) => readFlow(id);
export const readArrivalSource = (sourceId: string) => imports('GET /flow/sources/:sourceId', { params: { sourceId } });
export const readOrderBatch = (id: number) => readBatch(id);

/** 按订货单登记到货（服务端按订货单分到各张采购单） */
export const receiveOrderBatch = (batch: { id: number }, body: Parameters<typeof receiveBatch>[1]) => receiveBatch(batch, body);

/** 不挂订货单的到货单的正文：到货的录入内容加请求号，改写时再带版本号 */
type ArrivalDocBody = Parameters<typeof createFlow>[1];
/** 不挂订货单的到货单：没有 id 是新登记，有 id 是改写这张 */
export const saveArrivalDoc = (input: { id?: number }, body: ArrivalDocBody) =>
  input.id ? updateFlow(input.id, body) : createFlow('arrival', body);
