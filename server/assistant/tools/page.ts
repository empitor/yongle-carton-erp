// 只管：看页面（page.observe）的工具定义。参数结构在 shared（页面交回结果也按它），执行在 page-bridge.ts。
import { pageObserveSchema } from '../../../shared/assistant/index.js';
import { toolSpec } from './define.js';

export const pageToolDefinitions = [
  toolSpec({
    name: 'page.observe',
    description:
      '看眼前的页面：要知道用户眼前的 ERP 页面上的提示、弹窗和表格时用。mode 默认 summary 概要，region 看某块区域，record 看当前打开的记录，full 看完整；offset、limit 翻表格。查数据优先用查记录的命令。',
    risk: 'read',
    schema: pageObserveSchema,
  }),
];
