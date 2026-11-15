import { scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/** 账号密码的哈希：scrypt，64 字节，存成十六进制（建号、改密在 AuthManager.hashPassword） */
export const HASH_BYTES = 64;

/** 登录时核对密码放到线程池里算：同步算一次约 30 毫秒，会堵住所有人的请求 */
export const scryptAsync = (password: string, salt: string) =>
  (promisify(scrypt) as (p: string, s: string, n: number) => Promise<Buffer>)(password, salt, HASH_BYTES);

/**
 * 算出来的哈希和库里存的对不对得上。库里的哈希格式坏了（长度不对、不是十六进制）当密码错，
 * 写一条服务端日志（只写账号编号），不让登录回“保存失败”。
 */
export function hashMatches(computed: Buffer, stored: unknown, userId: string) {
  const expected = Buffer.from(String(stored ?? ''), 'hex');
  if (expected.length !== HASH_BYTES || computed.length !== HASH_BYTES) {
    console.error('账号 ' + userId + ' 的密码哈希格式不对，按密码错误处理；请让管理员给这个账号重置密码。');
    return false;
  }
  return timingSafeEqual(computed, expected);
}
