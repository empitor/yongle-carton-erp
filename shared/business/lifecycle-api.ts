import type { z } from 'zod';
import type { ArchiveResult, recordArchiveInputSchema } from '../core/index.js';
import type { RecordEntity } from './operations.js';

/*
 * 六类档案（客户、产品、订单、供应商、采购单、库存品）批量归档、恢复的接口表
 * （服务端 server/lifecycle/lifecycle-router.ts，挂在 /api 下；前端 src/recordkit/record-api.ts）。
 * 表的写法见 shared/core/api-table.ts。正文照 shared/core/archive-input.ts 的结构写，服务端照样先校验。
 */

/** 批量归档、恢复（server/core/records/archive.ts 的 changeArchive） */
type ArchiveBody = z.input<typeof recordArchiveInputSchema>;

export type LifecycleApi = { [E in RecordEntity as `POST /${E}/batch`]: { body: ArchiveBody; response: ArchiveResult<number> } };
