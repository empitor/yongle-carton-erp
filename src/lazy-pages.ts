// 大页面按需加载，首屏只下载用到的部分。App 和归档页（RecordPages）共用这几个定义。
import { lazy } from 'react';

export const FinancePages = lazy(() => import('./finance/pages').then((m) => ({ default: m.FinancePages })));
export const AiSettingsHub = lazy(() => import('./AiSettingsHub'));
export const AccountManagement = lazy(() => import('./admin/pages').then((m) => ({ default: m.AccountManagement })));
export const OperationsPage = lazy(() => import('./records/pages').then((m) => ({ default: m.OperationsPage })));
export const FlowPage = lazy(() => import('./flow/pages').then((m) => ({ default: m.FlowPage })));
export const GlobalAssistant = lazy(() => import('./assistant/pages').then((m) => ({ default: m.GlobalAssistant })));
export const OrderImportPage = lazy(() => import('./import/pages').then((m) => ({ default: m.OrderImportPage })));
