import { z } from 'zod';

/** 一次最多归档、恢复几条 */
const MAX_ARCHIVE_ITEMS = 1000;

/**
 * 批量归档、恢复的正文（服务端 server/core/records/archive.ts 的 changeArchive 按它校验，接口表照它的输入 z.input 写类型）。
 * id 是编号的写法、firstVersion 是版本号从几开始，由记录种类定；业务库里的记录用 recordArchiveInputSchema。
 */
export function archiveInputSchema<Id extends z.ZodType<number | string>>(id: Id, firstVersion: 0 | 1) {
  return z.strictObject({
    action: z.enum(['archive', 'restore']),
    acknowledged: z.literal(true).optional(),
    items: z
      .array(z.strictObject({ id, version: z.number().int().min(firstVersion) }))
      .min(1)
      .max(MAX_ARCHIVE_ITEMS),
  });
}

/** 批量归档、恢复的回答：逐条的编号、成没成、说明（server/core/records/archive.ts 的 changeArchive 交回，各接口表照它写） */
export type ArchiveResult<Id extends number | string> = { results: { id: Id; success: boolean; message: string }[] };

/** 业务库里的记录（档案、单据）：编号是正整数，版本号从 1 起 */
export const recordArchiveId = z.number().int().positive();
export const RECORD_FIRST_VERSION = 1;
export const recordArchiveInputSchema = archiveInputSchema(recordArchiveId, RECORD_FIRST_VERSION);
