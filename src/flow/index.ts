// 对外接口：别的模块只能从这里引用这个模块（页面入口在 pages.ts）
// AI 导入的到货单类型直接用这里的到货表单、核对窗和核对办理，到货的编辑和核对入库只有这一套
export { FlowEditor } from './FlowEditor';
export { FlowReviewDialog } from './FlowDialogs';
// 改已生效的到货、送货、完工单的数量这类只有“更正××单”一条路：AI 导入、数据管理也打开它
export { default as CorrectionDialog } from './CorrectionDialog';
// 已生效的到货、送货、完工单只改说明的“编辑”：单据详情和数据管理同一个窗口
export { default as DocumentInfoDialog } from './DocumentInfoDialog';
export { confirmPreview, createFlow, previewFlow, readFlow, updateFlow } from './flow-api';
export { confirmedMessage, correctLabel, infoSavedMessage, isCorrectable } from './flow-words';
