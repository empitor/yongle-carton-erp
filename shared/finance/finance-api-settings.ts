// 归前端财务-甲。财务接口表“设置”一块（服务端 server/finance/routes.ts 的 settingsRoutes）：启用、科目、期间、记账模板。
import type { z } from 'zod';
import type { accountChangeSchema, openingSchema, settingsPatchSchema } from './finance.js';
import type { Body, Read } from './finance-api-shapes.js';

/** 科目（fin_accounts 整行，照 server/finance/settings.ts）：enabled、used 是 0 或 1 */
type StoredAccount = {
  code: string;
  parent_code: string | null;
  name: string;
  category: string;
  direction: string;
  cash_kind: string | null;
  auxiliary: string | null;
  enabled: number;
  version: number;
  used: number;
};
/** 科目表一行：加上是不是末级（没有下级科目为 1） */
type FinanceAccountRow = StoredAccount & { leaf: number };
/** 会计期间（fin_periods 一行）：状态是 open 或 closed；结账检查、结账、反结账也回它 */
export type FinancePeriod = { period: string; status: string; version: number };

/** 记账模板（照 server/finance/template.ts 的 templateView）：每个用途用哪个科目 */
type TemplateView = { name: string; version: number; mapping: Record<string, string> };

type SettingsPatch = z.output<typeof settingsPatchSchema>;
/**
 * 页面看到的财务设置（照 server/finance/settings.ts 的 settingsView：读、改设置、启用财务都回它）：
 * 启用月份（没启用是 null）、纳税人身份（启用前可能没定）、记账规则、账龄分段、小税种税率（万分之几，没填是 null）、归档年限的说明。
 * 资金发票块的税务底稿也用纳税人身份、税率这两项
 */
export type FinanceSettingsView = {
  version: number;
  startPeriod: string | null;
  taxpayer: NonNullable<SettingsPatch['taxpayer']> | null;
  requireSeparateApprover: boolean;
  revenueRecognition: NonNullable<SettingsPatch['revenueRecognition']>;
  costAllocation: NonNullable<SettingsPatch['costAllocation']>;
  agingDays: NonNullable<SettingsPatch['agingDays']>;
  archiveRetention: {
    voucherYears: number;
    ledgerYears: number;
    bankYears: number;
    taxWorkpaperYears: number;
    starts: string;
  };
  taxRates: NonNullable<SettingsPatch['taxRates']>;
};

export type SettingsApi = {
  'GET /finance/settings': { response: FinanceSettingsView };
  'PUT /finance/settings': { body: z.input<typeof settingsPatchSchema>; response: FinanceSettingsView };
  /** 全部科目，按编码排 */
  'GET /finance/accounts': { response: FinanceAccountRow[] };
  /** 新建或改一个科目，回存好的那一行 */
  'PUT /finance/accounts': { body: z.input<typeof accountChangeSchema>; response: StoredAccount };
  /** 全部会计期间，按月份排 */
  'GET /finance/periods': { response: FinancePeriod[] };
  'GET /finance/opening': Read;
  /** 启用财务（期初余额、纳税人身份一起锁定），回启用后的设置 */
  'POST /finance/opening/enable': { body: z.input<typeof openingSchema>; response: FinanceSettingsView };
  'GET /finance/templates': { response: TemplateView[] };
  /** 改一个记账模板的科目（正文规则在 server/finance/template.ts） */
  'PUT /finance/templates': { body: Body; response: TemplateView };
};
