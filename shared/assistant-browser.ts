import { z } from 'zod';
import { pageExpectedSchema } from './assistant-page.js';
export const browserActionSchema = z.strictObject({
  action: z.enum(['click', 'type', 'key', 'scroll', 'upload', 'dialog']),
  frameId: z.string().uuid(),
  x: z.number().int().nonnegative().optional(),
  y: z.number().int().nonnegative().optional(),
  text: z.string().max(6000).optional(),
  key: z
    .enum([
      'Enter',
      'Escape',
      'Tab',
      'Backspace',
      'Delete',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      'PageUp',
      'PageDown',
      'ControlOrMeta+A',
    ])
    .optional(),
  deltaY: z.number().int().min(-3000).max(3000).optional(),
  attachmentId: z.string().uuid().optional(),
  accept: z.boolean().optional(),
  outcome: pageExpectedSchema.optional(),
});
export const browserTools = [
  {
    name: 'browser.capture',
    description:
      '读取已连接本地ERP浏览器的真实视区截图与确认框。敏感区域遮盖，返回frameId和图像；未连接时不可用。DOM/API优先，图像仅在当前模型支持视觉输入时可定位。',
    arguments: {},
    risk: 'read',
  },
  {
    name: 'browser.act',
    description:
      '对真实截图中的本地ERP视区执行鼠标/键盘/滚动、选择当前聊天附件或处理真实确认框。必须使用最新frameId；不会控制其他网站、Windows或任意文件。业务操作后仍需原API/page.verify核验。',
    arguments: {
      action: 'click/type/key/scroll/upload/dialog',
      frameId: '最新截图ID',
      x: 1,
      y: 1,
      text: '普通输入内容',
      attachmentId: '当前聊天附件UUID',
      outcome: '需要业务核验时绑定module/id/完整expected',
    },
    risk: 'read',
  },
] as const;
