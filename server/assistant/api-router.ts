// 助手收发 JSON 的地址：按接口表（shared/assistant/assistant-api.ts）用 route() 注册，正文先按表里同一份结构校验。
// 原始字节、事件流、下载原件这几个在 router.ts，卡片的三个按钮在 preview-router.ts，记忆在 memory-router.ts。
import type { Router } from 'express';
import { isSuperMode, one, requireSuperAdminAccount, route, rows } from '../core/index.js';
import type { Actor, RequestAuth } from '../core/index.js';
import {
  acknowledgedBody,
  cancelUploadBody,
  type AssistantApi,
} from '../../shared/assistant/index.js';
import { AppError } from '../core/index.js';
import type { AssistantManager } from './manager.js';

/** 这个 router 挂在 /api/assistant 下（app.ts） */
export const ASSISTANT_MOUNT = '/assistant';
const lastExecution = rows.assistant_audit.pick({ state: true }).extend({ at: rows.assistant_audit.shape.created_at });

/** 插件和工具的启停（写助手操作记录）：先核对能不能改、再按 pluginSettingBody、toolSettingBody 校验，都在 tool-registry.ts */
function toolSettingRoutes(router: Router, manager: AssistantManager, auth: RequestAuth) {
  const on = route<AssistantApi>(router, ASSISTANT_MOUNT);
  const logSetting = (actor: Actor, tool: string, body: unknown) =>
    manager.store.db
      .prepare('INSERT INTO assistant_audit(user_id,thread_id,tool,state,document,created_at) VALUES(?,NULL,?,?,?,?)')
      .run(actor.id, tool, 'completed', JSON.stringify(body), new Date().toISOString());
  // 启停要先进超级管理员模式（tool-registry.ts 的 set）；分组清单只有设置 → 高级用，只给超级管理员账号看
  on('GET /assistant/plugins', ({ req }) => {
    const actor = requireSuperAdminAccount(auth.signedIn(req), '查看插件与工具');
    return { ...manager.registry.pluginsView(actor), canManage: isSuperMode(actor) };
  });
  on('POST /assistant/plugins/settings', ({ body, req }) => {
    const actor = auth.signedIn(req);
    manager.registry.setPlugin(body, actor);
    logSetting(actor, 'plugins.configure', body);
    return manager.registry.pluginsView();
  });
  on('GET /assistant/tools', ({ req }) => {
    const actor = auth.signedIn(req);
    const state = manager.registry.view(actor);
    const lastRun = (tool: string) =>
      one(
        manager.store.db,
        lastExecution,
        'SELECT state,created_at AS at FROM assistant_audit WHERE user_id=? AND tool=? ORDER BY id DESC LIMIT 1',
        actor.id,
        tool,
      ) || null;
    return { ...state, canManage: isSuperMode(actor), tools: state.tools.map((t) => ({ ...t, lastExecution: lastRun(t.name) })) };
  });
  on('POST /assistant/tools/settings', ({ body, req }) => {
    const actor = auth.signedIn(req);
    manager.registry.set(body, actor);
    logSetting(actor, 'tools.configure', body);
    return manager.registry.view(actor);
  });
}

/** 会话的新建、打开、清空、删除、停止，附件的撤回上传和删除，页面交回“看一眼”的结果 */
function threadRoutes(router: Router, manager: AssistantManager, auth: RequestAuth) {
  const on = route<AssistantApi>(router, ASSISTANT_MOUNT);
  on('GET /assistant', ({ req }) => manager.state(auth.actor(req)));
  on('POST /assistant/page/results', ({ body, req }) =>
    manager.pageBridge.complete(body, auth.signedIn(req), auth.sessionBinding(req)),
  );
  // 新建会话、停止回复不看正文
  on('POST /assistant/threads', ({ req }) => manager.create(auth.actor(req)), { status: 201 });
  on('GET /assistant/threads/:id', ({ param, req }) => manager.view(param('id'), auth.actor(req)));
  on('POST /assistant/threads/:id/clear', ({ param, body, req }) => {
    acknowledgedBody.parse(body);
    return manager.clear(param('id'), auth.actor(req));
  });
  on('POST /assistant/threads/:id/delete', ({ param, body, req }) => {
    acknowledgedBody.parse(body);
    manager.removeThread(param('id'), auth.actor(req));
    return { deleted: true };
  });
  on('POST /assistant/threads/:id/cancel', ({ param, req }) => {
    manager.cancel(param('id'), auth.actor(req));
    return { ok: true };
  });
  on('POST /assistant/threads/:id/attachments/cancel-upload', ({ param, body, req }) => {
    const input = cancelUploadBody.parse(body);
    if (manager.isBusy(param('id'))) throw new AppError('请先停止当前AI回复。', 409);
    return manager.attachments.cancelUpload(param('id'), input.uploadId, auth.actor(req));
  });
  on('POST /assistant/attachments/:id/delete', ({ param, body, req }) => {
    acknowledgedBody.parse(body);
    const file = manager.attachments.info(param('id'), auth.actor(req));
    if (manager.isBusy(file.threadId)) throw new AppError('请先停止本会话AI回复，再删除附件。', 409);
    return manager.removeAttachment(param('id'), auth.actor(req));
  });
}

/** 收发 JSON 的地址都在这里注册 */
export function jsonRoutes(router: Router, manager: AssistantManager, auth: RequestAuth) {
  threadRoutes(router, manager, auth);
  toolSettingRoutes(router, manager, auth);
}
