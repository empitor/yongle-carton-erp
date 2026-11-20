import type { z } from 'zod';
import type { ApiJson, customerSchema, orderSchema, productSchema } from '../core/index.js';
import type {
  dataManagementModules,
  dataManagementTemplate,
  flowInput,
  purchaseSchema,
  stockItemSchema,
  supplierSchema,
} from '../business/index.js';
import type { ResetPreview, ResetResult, resetPreviewQuerySchema, resetRequestSchema } from './business-reset.js';
import type { managementCommandSchema, managementRecordsQuerySchema } from './management-command.js';
import type { WorkspaceResponse, pageWorkspaceActionSchema, workspaceCommandSchema } from './workspace-command.js';

/*
 * 数据管理（本机管理员）的接口表：服务端 server/admin/data-management-router.ts（挂在 /api/management 下），
 * 前端 src/admin/data-api.ts。表的写法见 shared/core/api-table.ts。查询参数和正文照服务端的 zod 规则的输入写，服务端照样先校验。
 */

/**
 * 一条记录：各模块的读接口组装好的那一行原样交出去（客户、产品、订单、供应商、采购单、库存品、四种单据），
 * 这里只认一定有的编号和版本；列表显示另补的几项（库存品用没用过、到货单的订货单号和原件文件名、供应商和客户名）也在里面。
 */
type ManagedRecord = { readonly id: number; readonly version: number } & { readonly [key: string]: ApiJson | undefined };
/** 编辑窗用的内容：档案、订单、采购单、库存品按各自的保存规则整理，单据按单据的录入规则整理 */
type ManagedInput =
  | z.output<typeof customerSchema>
  | z.output<typeof productSchema>
  | z.output<typeof orderSchema>
  | z.output<typeof supplierSchema>
  | z.output<typeof purchaseSchema>
  | z.output<typeof stockItemSchema>
  | ReturnType<typeof flowInput>;
type DataManagementModule = (typeof dataManagementModules)[number];
/** 一个模块的记录：新建模板，和每条列表显示的 record、编辑窗用的 input */
type ManagedList = {
  module: DataManagementModule;
  template: ReturnType<typeof dataManagementTemplate>;
  records: { record: ManagedRecord; input: ManagedInput }[];
};
/**
 * 数据管理命令办完：办了几条、每条的结果（各模块保存、单据流转、归档给的，原样交出去；
 * 同一请求再来时服务端只按 JSON 核对存下的那份，所以这里只认是 JSON）。删除不走这里，走删除引擎（deletion-api.ts）
 */
type ManagementResult = {
  module: DataManagementModule;
  action: z.output<typeof managementCommandSchema>['action'];
  count: number;
  results: readonly ApiJson[];
};
/** 列表上的一份识别文件：编号、版本号、文件名（归档的没记文件名时是空）。在用的另带任务、识别类型这些，数据管理不用，不列 */
type WorkspaceRow = { id: string; revision: number; fileName: string | null };
/** 内容和结构对不上、读不出来的一份：编号、版本号（够删掉它）、给人看的说明 */
type UnreadableWorkspace = { id: string; revision: number; problem: string };

export type DataManagementApi = {
  'GET /management/records': { query: z.input<typeof managementRecordsQuerySchema>; response: ManagedList };
  'GET /management/reset-preview': { query: z.input<typeof resetPreviewQuerySchema>; response: ResetPreview };
  'POST /management/reset': { body: z.input<typeof resetRequestSchema>; response: ResetResult };
  'POST /management/execute': { body: z.input<typeof managementCommandSchema>; response: ManagementResult };
  /** AI 识别工作区：在用的、归档的，和读不出来的 */
  'GET /management/workspaces': {
    response: { active: WorkspaceRow[]; archived: WorkspaceRow[]; unreadable: UnreadableWorkspace[] };
  };
  'POST /management/workspaces': {
    body: z.input<typeof workspaceCommandSchema> & z.input<typeof pageWorkspaceActionSchema>;
    response: WorkspaceResponse;
  };
};
