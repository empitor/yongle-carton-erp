import { z } from 'zod';

/** 一次最多管理几份识别文件 */
const WORKSPACE_BATCH_MAX = 200;
/** 归档、恢复、删除识别文件没带版本时的说法 */
export const WORKSPACE_REVISION_MISSING = '归档、恢复、删除识别文件要带上它的版本（revision），请先刷新再操作。';
/**
 * 识别文件的命令（数据管理窗口的复制、打开，助手的 management.workspaces）：
 * 改状态的（归档、恢复、永久删除）要带上看到时的版本，版本对不上就拦；复制、打开只读不用。
 */
export const workspaceCommandSchema = z
  .strictObject({
    requestId: z.uuid(),
    action: z.enum(['fork', 'restore', 'delete', 'archive', 'open']),
    items: z
      .array(z.strictObject({ id: z.uuid(), revision: z.number().int().nonnegative().optional() }))
      .min(1)
      .max(WORKSPACE_BATCH_MAX),
  })
  .refine((v) => ['fork', 'open'].includes(v.action) || v.items.every((i) => i.revision !== undefined), {
    message: WORKSPACE_REVISION_MISSING,
    path: ['items'],
  });
/** 数据管理窗口只复制、打开识别文件：页面上的归档、恢复、删除走 AI 导入的地址（/api/ai/imports/batch、delete-many） */
export const pageWorkspaceActionSchema = z.object({ action: z.enum(['fork', 'open']) });
/**
 * 识别文件命令的结果：逐份办得怎样（办成的给办完以后的识别文件，删除给编号；没办成的写原因），和合成一句给人看的说法。
 * 同一请求再来时交回存下的这一份，按这个结构核对：识别文件的内容只认编号，其余原样交回。
 */
export const workspaceResponseSchema = z.object({
  results: z.array(
    z.discriminatedUnion('success', [
      z.object({ id: z.string(), success: z.literal(true), result: z.object({ id: z.string() }).catchall(z.json()) }),
      z.object({ id: z.string(), success: z.literal(false), message: z.string() }),
    ]),
  ),
  message: z.string(),
});
export type WorkspaceResponse = z.output<typeof workspaceResponseSchema>;
