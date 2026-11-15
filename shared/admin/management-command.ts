import { z } from 'zod';
import { AUDIT_SOURCE } from '../core/index.js';
import { dataManagementCommandSchema, dataManagementModules } from '../business/index.js';

/**
 * 页面发来的数据管理命令：多认一项 entry（数据管理窗口带“数据管理”这个来源），这次办的事审计都记成数据管理。
 * 生产页、仓库页、到货识别借这个接口做的不带，记成页面；助手的命令按 dataManagementCommandSchema 校验，不认这一项。
 */
export const managementCommandSchema = dataManagementCommandSchema.extend({
  entry: z.literal(AUDIT_SOURCE.dataManagement).optional(),
});
/** 数据管理列表的查询参数：哪个模块 */
export const managementRecordsQuerySchema = z.object({ module: z.enum(dataManagementModules) });
