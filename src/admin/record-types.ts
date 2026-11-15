import type { ApiTable } from '../../shared/core/index';
import type { DataManagementApi } from '../../shared/admin/index';
import { dataManagementModules } from '../../shared/business/index';
// 数据管理前端共用的类型：接口给的记录和编辑窗里的内容都是 JSON，按字段名一格一格地显示和改。

/** 接口里能原样来回的 JSON 值（数据管理的记录、编辑窗里的内容都是它） */
export type Json = ApiTable[`GET /${string}`]['response'];
/** 一个 JSON 对象：一条记录、一项明细、一组预估成本 */
export type JsonObject = { [key: string]: Json | undefined };
export const isJsonObject = (v: Json | undefined): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const isJsonList = (v: Json | undefined): v is readonly Json[] => Array.isArray(v);
/** 一个值给人看的文字：文字原样，数字转成文字；没填、对象、真假都是空的 */
export const textOf = (v: Json | undefined): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';

/** 数据管理的十种业务记录（另有 workspaces：AI 识别工作区，走识别导入的地址） */
export type ManagedModule = (typeof dataManagementModules)[number];
export const isManagedModule = (module: string): module is ManagedModule =>
  dataManagementModules.some((m) => m === module);
/** 操作要落到哪个业务模块上：模块名对不上就说清楚，不发请求（下拉里只有这十种和识别工作区） */
export function managedModule(module: string): ManagedModule {
  if (!isManagedModule(module)) throw new Error('没有这个数据管理模块：' + module + '，请刷新后重试。');
  return module;
}

type ManagedList = DataManagementApi['GET /management/records']['response'];
/** 一条业务记录在列表上的样子：record 是列表给的那条（编号是数字），input 是编辑窗用的内容 */
export type BusinessRecord = ManagedList['records'][number];
/** 列表给的一条业务记录：编号、版本号，和列表显示用的各项 */
export type ManagedRecord = BusinessRecord['record'];
/** AI 识别工作区的一份文件，整理成和业务记录一样的样子：编号是文字，版本号是 revision，名称是文件名 */
type WorkspaceShown = {
  readonly id: string;
  readonly version: number;
  readonly archived: boolean;
  readonly name: string | null;
  readonly [key: string]: Json | undefined;
};
/** 数据管理里一条记录在列表上的样子：业务记录带编辑窗用的 input；识别文件没有编辑窗，没有它 */
export type ListedRecord = BusinessRecord | { record: WorkspaceShown; input?: undefined };
/** 选中的业务记录（识别文件不走数据管理命令和删除）；混进了识别文件说明列表和模块错开了，说清楚、不发 */
export function businessRows(rows: readonly ListedRecord[]): BusinessRecord[] {
  return rows.map((row) => {
    if (row.input === undefined) throw new Error('选中的不是业务记录，请刷新后重试。');
    return row;
  });
}
/**
 * 只有识别文件才有的：复制成新任务、删除（走 AI 导入的地址）。业务记录的删除不在这里，
 * 打开和业务页面同一个删除窗（LinkedDialogs 的 delete，发 /deletions/execute）
 */
type WorkspaceOnlyAction = 'fork' | 'delete';
export const isWorkspaceOnly = (action: DataAction): action is WorkspaceOnlyAction => action === 'fork' || action === 'delete';
/** 数据管理窗口里能办的事：数据管理命令的几种动作（改、归档、恢复、确认……），加上识别文件才有的两样 */
export type DataAction = DataManagementApi['POST /management/execute']['body']['action'] | WorkspaceOnlyAction;
