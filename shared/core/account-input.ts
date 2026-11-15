import { z } from 'zod';
import { accountLevels } from './accounts.js';
import { PASSWORD_MAX_LENGTH, passwordAllowed, passwordHint } from './password-policy.js';

/*
 * 登录、账号、申请这些接口收的正文：服务端（server/core 的 auth-router、login-route、account-router、account-request-router）
 * 按它校验，接口表（account-api.ts）照它的输入写正文类型。
 */

/** 新设的密码（建号、申请、改密都按它查） */
const newPassword = z.string().refine(passwordAllowed, '密码' + passwordHint + '。');
/** 账号名最多几个字 */
const ACCOUNT_NAME_MAX = 60;
/** 账号名（建号、申请、登录、改名都按它查） */
const accountName = z.string().trim().min(1).max(ACCOUNT_NAME_MAX);
/** 输入已有的密码（登录、验证本人、改密时的当前密码）：不查规则，只限长度 */
const enteredPassword = z.string().min(1).max(PASSWORD_MAX_LENGTH);
/** 申请账号时的说明最多几个字（填错时的提示也说这个数） */
export const ACCOUNT_NOTE_MAX = 200;

/** 不收任何字段的正文（退出超级管理员模式、发临时密码、拒绝申请） */
export const emptyBodySchema = z.strictObject({});
/** 建首个管理员 */
export const setupSchema = z.strictObject({ name: accountName, password: newPassword });
/** 登录：密码不查规则和长度，长度提示放在建号和改密，登录只回答“对”或“错” */
export const loginSchema = z.strictObject({ name: accountName, password: enteredPassword });
/** 改自己的密码：当前密码和新密码 */
export const passwordChangeSchema = z.strictObject({ current: enteredPassword, password: newPassword });
/** 进超级管理员模式：验本人密码 */
export const superModeEnterSchema = z.strictObject({ password: enteredPassword });
/** 申请账号（不用登录） */
export const accountApplySchema = z.strictObject({
  name: accountName,
  password: newPassword,
  note: z.string().trim().max(ACCOUNT_NOTE_MAX).default(''),
});
/** 忘记密码（不用登录） */
export const passwordForgotSchema = z.strictObject({ name: accountName });
/** 管理员建号 */
export const accountCreateSchema = z.strictObject({ name: accountName, password: newPassword, level: z.enum(accountLevels) });
/** 改级别、停用或启用 */
export const accountUpdateSchema = z.strictObject({ level: z.enum(accountLevels).optional(), disabled: z.boolean().optional() });
/** 批准申请：申请账号的选级别（可改名），忘记密码的不带 */
export const requestApproveSchema = z.strictObject({ name: accountName.optional(), level: z.enum(accountLevels).optional() });
