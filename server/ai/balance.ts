import { z } from 'zod';
import type { AiBalance } from '../../shared/ai/index.js';
import { closeAfter, openDeepSeek, readShaped, SMALL_JSON_BYTES, type AiTransport } from './transport.js';

/** 最多列几种币种的余额 */
const MAX_BALANCES = 4;
/**
 * 一种币种的余额：字段缺了或不是金额文字的按 0.00 算，整条不是对象的也照样算一条。
 * zod 4 里 z.unknown() 的栏缺了也报错，所以都写 optional（is_available 缺了按可用算）。
 */
const balanceInfoSchema = z
  .object({
    currency: z.unknown().optional(),
    total_balance: z.unknown().optional(),
    granted_balance: z.unknown().optional(),
    topped_up_balance: z.unknown().optional(),
  })
  .catch({});
const balanceSchema = z.object({
  is_available: z.unknown().optional(),
  balance_infos: z.array(balanceInfoSchema).catch([]),
});
const money = (v: unknown) => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? v : '0.00');

/** DeepSeek 查余额（/user/balance）：免费，401 说明密钥不对，is_available 说明余额够不够。测试连接就用它。 */
export async function getBalance(transport: AiTransport, key: string, signal?: AbortSignal): Promise<AiBalance> {
  const { response, deadline } = await openDeepSeek(transport, {
    op: 'balance', path: '/user/balance', key, timeoutMs: 20_000, signal,
  });
  return closeAfter(deadline, async () => {
    const body = await readShaped(response, balanceSchema, SMALL_JSON_BYTES, deadline);
    return {
      available: body.is_available !== false,
      balances: body.balance_infos.slice(0, MAX_BALANCES).map((b) => ({
        currency: b.currency === 'USD' ? 'USD' : 'CNY',
        total: money(b.total_balance),
        granted: money(b.granted_balance),
        toppedUp: money(b.topped_up_balance),
      })),
      checkedAt: new Date().toISOString(),
    };
  });
}
