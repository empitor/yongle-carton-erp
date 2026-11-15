// 业务页面给别的前端模块用的服务接口（由 src/slots.ts 装进插槽，接口定义在 src/ui/slots.tsx）
import { readCatalog } from '../recordkit/catalog-api';

/** 往来单位：财务选客户、供应商时用 */
export const partiesService = {
  async list(kind: 'customer' | 'supplier'): Promise<{ id: number; name: string }[]> {
    const key = kind === 'customer' ? 'customers' : 'suppliers';
    return (await readCatalog([key]))[key];
  },
};
