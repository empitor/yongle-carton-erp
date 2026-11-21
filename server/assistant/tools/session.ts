// 只管：会话里的工具定义——聊天记录（chat.*）。
// 执行要用到本轮聊天的状态，在 conversation.ts 和 chat/ 里。
import { uuid } from './context.js';
import { z } from 'zod';
import { toolSpec } from './define.js';

/** 一次最多删几个会话 */
const DELETE_MAX = 200;

export const sessionTools = [
  toolSpec({
    name: 'chat.list',
    description: '查当前账号的聊天会话：标题、消息数、最后更新时间；current 是当前会话。',
    risk: 'read',
    schema: z.strictObject({}),
  }),
  toolSpec({
    name: 'chat.delete',
    description:
      '删当前账号的聊天记录，不动业务数据，删了找不回。threadIds 删指定的，all 删全部其他会话，includeCurrent 连当前会话也清。',
    risk: 'workflow',
    schema: z.strictObject({
      threadIds: z.array(uuid).min(1).max(DELETE_MAX).optional(),
      all: z.boolean().optional(),
      includeCurrent: z.boolean().optional(),
    }),
  }),
];
