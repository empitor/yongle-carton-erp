// 财务给别的模块用的服务接口（由 src/slots.ts 装进插槽，接口定义在 src/ui/slots.tsx）
import { finRead } from './fin-api';

export const financeService = {
  /** 近期到期的应收应付；没有财务权限时后端拒绝，调用方当作没有 */
  async dueSoon(days: number, limit: number) {
    const page = await finRead('GET /finance/due-soon', { query: { days, pageSize: limit } });
    return page.rows;
  },
};
