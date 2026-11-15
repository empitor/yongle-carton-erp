import { z } from 'zod';
import { dataManagementCommandSchema } from '../business/index.js';
/**
 * 助手的数据管理命令（management.execute）：一条命令一张卡片，一次动多条用明确的编号列表（items）。
 * dimensionPolicy：改产品、库存品的尺寸单位时，convert（默认）按原单位换算长宽高，relabel 只改单位标签。
 */
export const assistantManagementSchema = dataManagementCommandSchema.extend({
  dimensionPolicy: z.enum(['convert', 'relabel']).optional(),
});
