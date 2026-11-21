// 确认卡片上的三个按钮：改“库存怎么处理”（删除卡片）、不执行、确认执行。规则在 previews.ts；
// 这里只做和人在页面上删除同一规则的入口核对：本人密码、只能在服务器本机做的拒绝代理入口、卡片上看到的是不是现在这一版。
// 按接口表（shared/assistant/assistant-api.ts）用 route() 注册。
import type { Request, Router } from 'express';
import { z } from 'zod';
import { AppError, isLocalAdministrator, one, parseStoredJson, route, rows } from '../core/index.js';
import type { AuthManager } from '../core/index.js';
import { executeCardBody, type AssistantApi } from '../../shared/assistant/index.js';
import type { AssistantManager } from './manager.js';
import { assertCardCurrent, destructivePlan, localOnlyMessage, localOnlyPlan, unconfirmedDeletion } from './plan-rules.js';
import { ASSISTANT_MOUNT } from './api-router.js';
import { asJson, planCard } from './json-view.js';

/** 卡片上的方案（previews.ts 存在 document.plan 里）和执行回执；核对只要方案是哪条命令、带什么参数 */
const cardRow = rows.assistant_previews.pick({ result: true }).extend({ plan: z.string() });
const cardPlan = z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) });

/**
 * 从公网域名进来的：入口标记由 app 的前置中间件写在 res.locals 上，缺了按代理处理。
 * 只能在服务器本机做的操作（一键清空、识别工作区的删除）拒绝代理入口。
 */
const viaProxy = (req: Request) => req.res?.locals.proxyIngress !== false;

/** 确认执行：核对卡片还是这一版、代理入口、本人密码，再交给 previews.ts 的 commit */
async function executeCard(manager: AssistantManager, auth: AuthManager, req: Request, id: string, body: unknown) {
  const actor = auth.signedIn(req);
  const row = one(
    manager.store.db,
    cardRow,
    "SELECT json_extract(document,'$.plan') AS plan,result FROM assistant_previews WHERE id=? AND user_id=?",
    id,
    actor.id,
  );
  if (!row) throw new AppError('方案不存在或无权访问。', 404);
  const { password, ...input } = executeCardBody.parse(body);
  // 删除和人在页面上删除（/api/deletions）同一规则：本机最高管理员以外要在确认卡片上输入本人密码，
  // 在这里核验；要不要超级管理员模式由删除引擎在执行时核对。
  const proxy = viaProxy(req);
  // 已经执行过的方案（再点一次、网络重试）：直接返回原结果。删掉的单据已经不在了，
  // 再按删除规则判断会把它当成已核对的单据拒绝。会话绑定照样由 execute 核对。
  if (row.result) return manager.execute(id, input, actor, auth.sessionBinding(req), { proxy });
  let passwordVerified = false;
  const plan = parseStoredJson(cardPlan, row.plan, 'assistant_previews.document 的 plan（卡片 ' + id + '）');
  // 卡片上看到的不是现在这一版（别的标签页改了库存处理方式、改选的响应丢了）：先拒绝，不核验密码
  assertCardCurrent(plan, input.deletionDigest);
  if (proxy && localOnlyPlan(plan)) throw new AppError(localOnlyMessage(plan.tool), 403, 'proxy-deletion');
  // 还没核对的单据和人在页面上一样：不用密码
  if (destructivePlan(plan) && !unconfirmedDeletion(manager.tools.flow, plan) && !isLocalAdministrator(actor)) {
    await auth.verifyPassword(req, password);
    passwordVerified = true;
  }
  return manager.execute(id, input, auth.actor(req), auth.sessionBinding(req), { proxy, passwordVerified });
}

export function previewRoutes(router: Router, manager: AssistantManager, auth: AuthManager) {
  const on = route<AssistantApi>(router, ASSISTANT_MOUNT);
  // 删除确认卡片上改“库存怎么处理”：服务器按新选项重新生成这份方案（新摘要），不执行。
  // 正文由 previews.ts 先核对权限再按 inventoryPolicyBody 的同样规则校验
  on('POST /assistant/previews/:id/inventory-policy', ({ param, body, req }) =>
    planCard(manager.changeDeletionPolicy(param('id'), body ?? {}, auth.actor(req), auth.sessionBinding(req))),
  );
  // 人在确认卡片上点“不执行”：方案作废（不看正文）
  on('POST /assistant/previews/:id/reject', ({ param, req }) => manager.reject(param('id'), auth.actor(req), auth.sessionBinding(req)));
  // 执行结果是各命令自己的样子，按接口回答的规则转成 JSON
  on('POST /assistant/previews/:id/execute', async ({ param, body, req }) =>
    asJson(await executeCard(manager, auth, req, param('id'), body)),
  );
}
