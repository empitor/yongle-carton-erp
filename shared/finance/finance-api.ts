import type { CashApi } from './finance-api-cash.js';
import type { CostsApi } from './finance-api-costs.js';
import type { EventsApi } from './finance-api-events.js';
import type { LedgerApi } from './finance-api-ledger.js';
import type { OverviewApi } from './finance-api-overview.js';
import type { PartiesApi } from './finance-api-parties.js';
import type { ReportsApi } from './finance-api-reports.js';
import type { SettingsApi } from './finance-api-settings.js';

/*
 * 财务的接口表（服务端 server/finance/routes*.ts 用 route() 注册，挂在 /api/finance 下）。表的写法见 shared/core/api-table.ts。
 * 按页面分成几块（finance-api-<块>.ts，开头写着归前端哪一路），这里合成总表；共用的写法在 finance-api-shapes.ts。
 * 正文的规则已经在 shared/finance 的（设置、科目、期初、凭证）照它的输入写；别的正文、查询参数的规则和回答的结构还在
 * 各服务里（读库的行结构建在服务端的 rows 上，这里引不到），先写成 JSON 对象：服务端照样先用 zod 校验，
 * route() 保证回的都是 JSON 原样来回的值。各块逐条换成准确的类型（纯类型或 zod 视图结构），服务端的返回值由类型检查对上。
 * 不在表里的照旧用 express 注册（不是 JSON 来回）：导出 Excel 的 8 个（…/export）和归档包 GET /finance/archive/download、
 * 原件 GET /finance/attachments/:id（回文件），上传的 3 个 POST /finance/bank/upload、/attachments/upload、/payroll/upload（收原始字节）。
 */
export type FinanceApi = SettingsApi & LedgerApi & EventsApi & OverviewApi & PartiesApi & CashApi & CostsApi & ReportsApi;
