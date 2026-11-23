// 只管：助手窗口“记忆”面板用的地址（挂在 /api/assistant/memory 下，登录和页面凭证由 router.ts 先查过）。
// 都只动当前登录账号自己的记忆，返回面板要的全部（memory-store.ts 的 view）。和助手的 memory.* 工具能做的一样：
// 看、手动加、改、删、清空、开关自动记忆；面板是人自己在操作，不用带依据。按接口表（shared/assistant/assistant-api.ts）用 route() 注册。
import { Router, type Request } from 'express';
import { z } from 'zod';
import { route } from '../core/index.js';
import type { RequestAuth } from '../core/index.js';
import { memoryAutoSaveBody, memoryContentBody, type AssistantApi } from '../../shared/assistant/index.js';
import type { AssistantMemory } from './memory-store.js';

const id = z.coerce.number().int().positive();
/** 这个 router 挂的位置（在 /api 下） */
const MEMORY_MOUNT = '/assistant/memory';

export function memoryRouter(memory: AssistantMemory, auth: RequestAuth) {
  const router = Router();
  const on = route<AssistantApi>(router, MEMORY_MOUNT);
  const me = (req: Request) => auth.signedIn(req).id;
  on('GET /assistant/memory', ({ req }) => memory.view(me(req)));
  on(
    'POST /assistant/memory',
    ({ body, req }) => {
      memory.add(me(req), memoryContentBody.parse(body).content, 'manual');
      return memory.view(me(req));
    },
    { status: 201 },
  );
  // 设置、清空先注册：不然会被当成记忆编号
  on('POST /assistant/memory/settings', ({ body, req }) => {
    memory.setAutoSave(me(req), memoryAutoSaveBody.parse(body).autoSave);
    return memory.view(me(req));
  });
  on('POST /assistant/memory/clear', ({ req }) => {
    memory.clear(me(req));
    return memory.view(me(req));
  });
  on('POST /assistant/memory/:id', ({ param, body, req }) => {
    memory.update(me(req), id.parse(param('id')), memoryContentBody.parse(body).content);
    return memory.view(me(req));
  });
  on('POST /assistant/memory/:id/delete', ({ param, req }) => {
    memory.remove(me(req), id.parse(param('id')));
    return memory.view(me(req));
  });
  return router;
}
