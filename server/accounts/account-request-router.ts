import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { ACCOUNT_NOTE_MAX, HOUR_MS, accountApplySchema, passwordForgotSchema, passwordHint } from '../../shared/core/index.js';
import { accountRows } from './account-db.js';
import { authRoute, type AuthRoutesHost } from './auth-router.js';
import { done, refuse, count, exists, one } from '../core/index.js';

/*
 * 不用登录的两个接口（/api/auth 下，接口表 shared/core/account-api.ts）：申请账号、忘记密码。管理员处理申请在 account-router.ts。
 * 不管用户名存不存在都回答同样的话，不能借此试出谁有账号；成功也计数，访客地址按网段算（AuthManager.clientAddress）。
 * 被拒时只回 { message }（refuse，不带 code），成功一律 202。
 */

const PENDING_ACCOUNT_LIMIT = 50;
/** 每小时：同一网段申请几次、同一网段忘记密码几次、同一用户名登记几次忘记密码；同一网段同时排着的申请最多几个 */
const REQUEST_LIMITS = { applyPerHour: 5, forgotPerHour: 10, forgotPerName: 3, pendingPerNetwork: 3 };
const tooOften = '提交太频繁，请稍后再试，或直接联系管理员。';
const accepted = { status: 202 };

export function accountRequestRouter(auth: AuthRoutesHost) {
  const router = Router();
  const on = authRoute(router);
  on('POST /auth/apply', ({ body, req }) => {
    if (req.headers['x-erp-auth-token'] !== auth.csrf) return refuse(403, '页面已过期，请刷新。');
    if (!auth.configured()) return refuse(409, '系统还没有管理员。');
    const input = accountApplySchema.safeParse(body);
    if (!input.success) return refuse(400, '请填写用户名，密码' + passwordHint + '，说明不超过' + ACCOUNT_NOTE_MAX + '字。');
    const client = auth.clientAddress(req);
    if (auth.submissions.hit('apply:' + client, REQUEST_LIMITS.applyPerHour, HOUR_MS)) return refuse(429, tooOften);
    auth.pruneRequests();
    const waiting = count(auth.db, "SELECT COUNT(*) FROM account_requests WHERE kind='register'");
    // 先判断再算哈希：算哈希很耗 CPU，不能让人靠提交申请拖慢系统。
    if (waiting >= PENDING_ACCOUNT_LIMIT) return refuse(429, '待处理的申请太多，请直接联系管理员。');
    // 同名已在排队就不再收，也不覆盖：否则别人能改掉申请人自己设的密码。回一样的话，不暴露谁申请过。
    if (exists(auth.db, "SELECT 1 FROM account_requests WHERE kind='register' AND name=?", input.data.name)) return done;
    // 同一网段最多占 3 个名额，少量地址占不满全局队列。
    const mine = count(auth.db, "SELECT COUNT(*) FROM account_requests WHERE kind='register' AND client=?", client);
    if (mine >= REQUEST_LIMITS.pendingPerNetwork) return refuse(429, tooOften);
    const { salt, hash } = auth.hashPassword(input.data.password),
      id = randomUUID();
    auth.db
      .prepare(
        "INSERT INTO account_requests(id,kind,name,note,salt,password_hash,client,created_at) VALUES(?,'register',?,?,?,?,?,?)",
      )
      .run(id, input.data.name, input.data.note, salt, hash, client, auth.now());
    auth.event(null, 'account-requested:' + id);
    return done;
  }, accepted);
  on('POST /auth/forgot', ({ body, req }) => {
    if (req.headers['x-erp-auth-token'] !== auth.csrf) return refuse(403, '页面已过期，请刷新。');
    const input = passwordForgotSchema.safeParse(body);
    if (!input.success) return refuse(400, '请输入用户名。');
    if (auth.submissions.hit('forgot:' + auth.clientAddress(req), REQUEST_LIMITS.forgotPerHour, HOUR_MS)) return refuse(429, tooOften);
    // 同一用户名一小时只登记 3 次，再多照回同一句、不写库：换地址刷也写不满账号库
    if (auth.submissions.hit('forgot-name:' + input.data.name, REQUEST_LIMITS.forgotPerName, HOUR_MS)) return done;
    const user = one(auth.db, accountRows.userStateRow, 'SELECT id,disabled_at FROM users WHERE name=?', input.data.name);
    // 这里不改密码：别人乱提交也锁不住账号，管理员确认后才换临时密码。
    if (user && user.disabled_at === null) {
      auth.db
        .prepare(
          `INSERT INTO account_requests(id,kind,name,client,created_at) VALUES(?,'reset',?,?,?)
           ON CONFLICT(name) WHERE kind='reset' DO UPDATE SET client=excluded.client,created_at=excluded.created_at`,
        )
        .run(randomUUID(), input.data.name, auth.clientAddress(req), auth.now());
      auth.event(user.id, 'password-reset-requested');
    }
    return done;
  }, accepted);
  return router;
}
