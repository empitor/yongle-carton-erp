import { Suspense, createContext, useContext, type ComponentType } from 'react';
import type { ArchiveResult } from '../../shared/core/index';

/**
 * 插槽：前端模块用别的模块的东西，只通过这里定义的两种接口。
 * - 组件插槽：页面里留给别的模块的位置。比如订单详情里的“财务”段由财务模块提供，到货页里的“AI 识别送货单”由识别导入提供。
 * - 服务接口：要读写别的模块的数据（调它的后端接口）时，用这里定义好的函数，由那个模块实现。
 *   比如今日页列收件箱、本机管理员复制 AI 识别文件。页面不直接请求别的模块的后端地址。
 * 由最外层装配（src/slots.ts，在 main.tsx 里填进来）把各模块的实现放进去。
 * 没填时（单独测某个页面时就是这样）：组件插槽什么都不显示；收件箱、AI 识别文件、往来单位、到期应收应付当作没有数据；
 * 本机管理员操作（useAdmin）会报错，不会悄悄跳过。
 */

/*
 * 服务接口交出的数据：只列用的模块要的几项。基础模块看不到提供方模块的视图类型，提供方的视图要能赋给这里的类型
 * （类型检查在 src/slots.ts 装配时查）。
 */

/** 处理一份识别文件的结果：办成了带新文件的编号，没办成带原因（数据管理 shared/admin 的 WorkspaceResponse 里的一条） */
export type WorkspaceFileResult =
  | { id: string; success: true; result: { id: string } }
  | { id: string; success: false; message: string };
/** 收件箱的一条：今日页列的、订单编辑窗对照的几项（识别导入 shared/import 的 InboxItem） */
export type InboxSlotItem = {
  id: number;
  version: number;
  status: string;
  channel: string;
  senderName: string;
  conversation: string;
  text: string;
  fileName: string | null;
};
/** 今日页里的一份 AI 识别文件：那一行要的几项（识别导入的文件列表摘要） */
export type AiFileSlotItem = {
  id: string;
  fileName: string;
  hasDraft?: boolean;
  markStatus?: string;
  arrivalStatus?: string;
};
/** 今日页右栏近期到期的一笔应收应付（财务 GET /finance/due-soon 的一行）；kind 是 receivable 或 payable */
export type DueSoonRow = {
  id: number;
  installment_id: number;
  kind: string;
  party_name: string;
  balance: number;
  days_to_due: number;
};

/** 本机管理员用的数据管理接口 */
export type AdminService = {
  /** 复制一份 AI 识别文件（本机管理员用来改识别结果、重新识别） */
  forkWorkspace(id: string): Promise<{ results: WorkspaceFileResult[] }>;
};

export type Slots = {
  /** 订单、送货、到货详情里的“财务”段：这笔单据的应收应付、收付款和凭证（财务模块） */
  FinanceRelated?: ComponentType<{ kind: 'orders' | 'delivery' | 'arrival'; id: number }>;
  /** 本机管理员的数据管理编辑窗（数据管理） */
  DataManagementEditor?: ComponentType<{ close: () => void; initialModule?: string }>;
  /** 今日页里的 AI 识别文件：还要人处理的那些，和每份那一行的进度文字（识别导入） */
  aiFiles?: { open(): Promise<AiFileSlotItem[]>; note(workspace: AiFileSlotItem): string };
  /** 收件箱（识别导入）：今日页列待处理的，订单编辑窗对照原文，订单建好后标记已转成订单 */
  inbox?: {
    pending(limit: number): Promise<{ rows: InboxSlotItem[]; total: number }>;
    item(id: number): Promise<InboxSlotItem>;
    converted(item: { id: number; version: number }, kind: 'order'): Promise<void>;
    /** 收件的原文件下载地址 */
    fileUrl(id: number): string;
  };
  /** 往来单位（业务）：财务选客户、供应商 */
  parties?: { list(kind: 'customer' | 'supplier'): Promise<{ id: number; name: string }[]> };
  /** 今日页右栏近期到期的应收应付（财务）；没有财务权限时是空的 */
  finance?: { dueSoon(days: number, limit: number): Promise<DueSoonRow[]> };
  /** 本机管理员用的数据管理接口（数据管理） */
  admin?: AdminService;
  /** 识别文件的归档、恢复、永久删除（识别导入）：数据管理和 AI 导入页走同一个地址 */
  workspaceFiles?: {
    change(
      action: 'archive' | 'restore' | 'delete',
      items: { id: string; version: number }[],
    ): Promise<ArchiveResult<string>>;
  };
};

const SlotContext = createContext<Slots>({});
export const SlotProvider = SlotContext.Provider;
export const useSlots = () => useContext(SlotContext);

const adminMissing = () => Promise.reject(new Error('本机管理入口没有装上，请刷新页面后重试。'));
/** 本机管理员操作用的接口（数据管理提供）；没装上时调用会报错，不会悄悄跳过。 */
export function useAdmin(): AdminService {
  return useSlots().admin ?? { forkWorkspace: adminMissing };
}

export function FinanceRelatedSlot(props: { kind: 'orders' | 'delivery' | 'arrival'; id: number }) {
  const Impl = useSlots().FinanceRelated;
  return Impl ? (
    <Suspense fallback={null}>
      <Impl {...props} />
    </Suspense>
  ) : null;
}
export function DataManagementEditorSlot(props: { close: () => void; initialModule?: string }) {
  const Impl = useSlots().DataManagementEditor;
  return Impl ? (
    <Suspense fallback={null}>
      <Impl {...props} />
    </Suspense>
  ) : null;
}
