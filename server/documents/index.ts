// 单据导出的表的初始化规则（server/core/deletion-rules.ts）
import './deletion.js';
export { documentsRouter } from './router.js';
export { BusinessDocuments } from './service.js';
export { listExports, purgeExportFiles } from './export-records.js';
export { DocumentTemplateSettings } from './settings.js';
export { checkDocumentFonts } from './measure.js';
// 排版自检（scripts/linux/verify-layout.mjs、verify-runtime.mjs）：拿虚构样张按几种纸张排版，不碰业务数据
export { layoutCases } from './layout-check.js';
export { renderBusinessForm } from './render.js';
export { sampleDocument } from './sample.js';
