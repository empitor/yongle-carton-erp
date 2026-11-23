import type { z } from 'zod';
import type { deletionRequestSchema, deletionResultSchema, deletionSelection, impactRowSchema } from './deletion-request.js';

/*
 * 业务界面删除的接口表（服务端 server/lifecycle/deletion-router.ts，挂在 /api/deletions 下；前端 src/recordkit/record-api.ts）。
 * 表的写法见 shared/core/api-table.ts。正文照服务端的 zod 规则（deletion-request.ts）的输入写，服务端照样先校验。
 */

/** 删除预览：范围、范围摘要、影响清单，和库存怎么变 */
type DeletionPreview = {
  selection: z.output<typeof deletionSelection>;
  digest: string;
  impact: z.output<typeof impactRowSchema>[];
  /** 会连带别的独立记录（真删时必须带 digest） */
  hasIndependentImpact: boolean;
  /** 被删单据有几笔出入库流水要按“库存处理方式”处理；0 表示没动过库存 */
  inventoryChoice: number;
  inventoryEffect: string;
};

/** 不在本机删已核对的单据时另带本人密码（服务端单独拿出来验，其余是删除内容） */
type ExecuteBody = z.input<typeof deletionRequestSchema> & { password?: string };

export type DeletionApi = {
  'POST /deletions/preview': { body: z.input<typeof deletionSelection>; response: DeletionPreview };
  'POST /deletions/execute': { body: ExecuteBody; response: z.output<typeof deletionResultSchema> };
};
