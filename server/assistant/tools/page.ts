// 只管：看页面（page.observe）的工具在服务端的定义。说明和示例参数在 shared（前端也用），这里配上参数结构。
import { z } from 'zod';
import { pageObserveSchema, pageTools } from '../../../shared/assistant/index.js';

const schemas: Record<string, z.ZodType> = { 'page.observe': pageObserveSchema };
export const pageToolDefinitions = pageTools.map((t) => ({ ...t, schema: schemas[t.name] }));
