// 助手接口收的正文（接口表 assistant-api.ts 用 z.input，服务端用同一份校验）。
import { z } from 'zod';

/** 启停一组工具：带读到时的修订号，别人先改过就拒绝 */
export const pluginSettingBody = z.strictObject({ id: z.string(), enabled: z.boolean(), expectedRevision: z.number().int() });
/** 启停一个工具（插件整组的写成 plugin:组名） */
export const toolSettingBody = z.strictObject({ name: z.string(), enabled: z.boolean(), expectedRevision: z.number().int() });
/** 清空、删除这类要人确认过的 */
export const acknowledgedBody = z.strictObject({ acknowledged: z.literal(true) });
/** 撤回一次还没传完的附件 */
export const cancelUploadBody = z.strictObject({ uploadId: z.uuid(), acknowledged: z.literal(true) });
/** 删除卡片上改“库存怎么处理” */
export const inventoryPolicyBody = z.strictObject({ inventoryPolicy: z.enum(['preserve', 'recalculate']) });
/** 卡片上的范围摘要最多多少字 */
const DIGEST_CHARS = 200;
/** 确认执行一张卡片：删除卡片带上看到的范围摘要；不在本机删已核对的要带本人密码 */
export const executeCardBody = z.strictObject({
  acknowledged: z.literal(true),
  deletionDigest: z.string().min(1).max(DIGEST_CHARS).optional(),
  password: z.string().optional(),
});
