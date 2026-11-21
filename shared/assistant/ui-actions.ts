/**
 * 业务动作登记：一件会写库的事登记一条（哪种记录、做什么、按钮叫法、写地址、预览地址、服务函数、助手命令），
 * 界面、助手、数据管理都挂在这一条上。tests/feature-links-actions.test.ts 拿它对服务端的全部写地址、前端发请求的文件、
 * 助手的写入命令：没登记的写地址、同一种记录同一个动作出现第二条、第二个文件发同一个写地址、助手命令走别的服务，都会失败。
 * 能力表（页面、人工入口、读的地址、全部工具）在 ui-capabilities.ts，这里的 capability 指向它的 id。
 * 业务主线（档案、采购库存、单据、导出、唛头、收件箱、识别导入）和财务在这里；账号、助手、AI 设置、数据管理在 ui-actions-system.ts。
 */
import { systemActions } from './ui-actions-system.js';

export type UiAction = {
  /** 能力表（ui-capabilities.ts）里的哪一项 */
  capability: string;
  /** 动的是哪种记录 */
  record: string;
  /** 做什么（同一种记录上一个动词只许有一条） */
  verb: string;
  /** 界面上办这件事的按钮叫法；带数量的只写数量前面那段；没有按钮（页面自己发、只有助手能做）的写 [] */
  labels: readonly string[];
  /** 写地址：'方法 /地址'，不带 /api，变量段写 :id；路由里写死的几种段（比如三种提示词）写 :kind；只有助手能做的写 null，在 note 里写为什么 */
  api: string | null;
  /** 先算给人看、不落库的预览地址（同样写法，读的也算） */
  previews?: readonly string[];
  /** 界面和助手都走的服务函数：'类名.方法' 或 '函数名'；路由里直接写的写路由函数名 */
  service: string;
  /** 挂在这件事上的、会写库的助手命令 */
  tools?: readonly string[];
  note?: string;
};

const save = 'records.propose_save';
const lifecycle = ['records.propose_batch_lifecycle', 'records.propose_lifecycle'];
const archiveLabels = ['归档', '恢复', '批量归档', '批量恢复'];
/** 六类档案的批量归档、恢复：同一个服务（server/lifecycle/lifecycle.ts），地址按档案分 */
const archive = (record: string, path: string): UiAction => ({
  capability: 'records',
  record,
  verb: '归档或恢复',
  labels: archiveLabels,
  api: 'POST /' + path + '/batch',
  service: 'changeLifecycle',
  tools: lifecycle,
});
/** 客户、产品、订单的新建和编辑：createBusinessService（界面经 manualWrite，助手经 records-save.ts） */
const editable = (name: string, path: string): UiAction[] => [
  { capability: 'records', record: name, verb: '新建', labels: ['新建' + name], api: 'POST /' + path, service: 'createBusinessService', tools: [save] },
  { capability: 'records', record: name, verb: '编辑', labels: ['编辑'], api: 'PUT /' + path + '/:id', service: 'createBusinessService', tools: [save] },
];
/** 订单、采购单改状态：确认、退回、取消（要原因）、恢复，各一个地址 */
const status = (name: string, path: string, service: string, labels: Record<string, string>): UiAction[] =>
  Object.entries(labels).map(([action, label]) => ({
    capability: 'records',
    record: name,
    verb: label,
    labels: [label],
    api: 'POST /' + path + '/:id/' + action,
    service,
    tools: [save],
  }));

const records: UiAction[] = [
  ...editable('客户', 'customers'),
  ...editable('产品', 'products'),
  ...editable('订单', 'orders'),
  ...status('订单', 'orders', 'changeOrderStatus', { confirm: '确认订单', revert: '退回待确认', cancel: '取消订单', reinstate: '恢复为待确认' }),
  ...status('采购单', 'purchases', 'changePurchaseStatus', {
    confirm: '不导出，直接改成待到货',
    revert: '退回待订货',
    cancel: '取消采购单',
    reinstate: '恢复为待订货',
  }),
  { capability: 'records', record: '供应商', verb: '新建', labels: ['新建供应商'], api: 'POST /suppliers', service: 'saveSupplier', tools: [save] },
  { capability: 'records', record: '供应商', verb: '编辑', labels: ['编辑'], api: 'PUT /suppliers/:id', service: 'saveSupplier', tools: [save] },
  { capability: 'bulk-planning', record: '采购单', verb: '新建', labels: ['安排订料', '新建采购单'], api: 'POST /purchases', service: 'savePurchase', tools: [save] },
  { capability: 'records', record: '采购单', verb: '编辑', labels: ['编辑'], api: 'PUT /purchases/:id', service: 'savePurchase', tools: [save] },
  archive('客户', 'customers'),
  archive('产品', 'products'),
  archive('订单', 'orders'),
  archive('供应商', 'suppliers'),
  archive('采购单', 'purchases'),
  archive('库存品', 'stock_items'),
  { capability: 'inventory', record: '库存品', verb: '新建', labels: ['新建库存品'], api: 'POST /warehouse/items', service: 'saveItem', tools: [save] },
  { capability: 'inventory', record: '库存品', verb: '编辑', labels: ['编辑'], api: 'PUT /warehouse/items/:id', service: 'saveItem', tools: [save] },
  { capability: 'inventory', record: '库存品', verb: '出入库或盘点', labels: ['确认库存变动'], api: 'POST /warehouse/items/:id/move', service: 'move', tools: ['inventory.propose_movement'] },
];

const flow: UiAction[] = [
  {
    capability: 'bulk-planning',
    record: '单据',
    verb: '新建',
    labels: ['安排送货', '安排生产', '登记没有采购单的到货'],
    api: 'POST /flow/:id',
    service: 'FlowService.save',
    tools: [save],
    note: '地址是 /flow/:kind（送货、生产任务、没有采购单的到货）；完工单只走登记完工',
  },
  { capability: 'flow', record: '单据', verb: '编辑待核对的', labels: ['编辑'], api: 'PUT /flow/:id', service: 'FlowService.save', tools: [save] },
  { capability: 'flow', record: '单据', verb: '归档或恢复', labels: archiveLabels, api: 'POST /flow/batch', service: 'archiveFlowDocuments', tools: lifecycle },
  {
    capability: 'flow',
    record: '单据',
    verb: '核对生效',
    labels: ['核对入库', '确认入库', '确认出库', '不导出直接出库'],
    api: 'POST /flow/:id/confirm',
    previews: ['POST /flow/:id/preview'],
    service: 'confirm',
    tools: ['flow.propose_confirmation'],
  },
  { capability: 'flow', record: '单据', verb: '取消', labels: ['取消这次送货', '取消这次到货', '取消这次完工', '取消这张任务'], api: 'POST /flow/:id/cancel', service: 'cancel', tools: ['flow.propose_cancel'] },
  { capability: 'flow', record: '单据', verb: '撤销', labels: ['撤销这次送货', '撤销这次到货', '撤销这次完工', '撤销这张任务'], api: 'POST /flow/:id/reverse', service: 'reverse', tools: ['flow.propose_reversal'] },
  {
    capability: 'flow',
    record: '单据',
    verb: '更正',
    labels: ['更正到货单', '更正送货单', '更正完工单', '提交更正'],
    api: 'POST /flow/:id/correct',
    previews: ['POST /flow/:id/correction-preview'],
    service: 'correctDocument',
    tools: ['arrival.correct', 'delivery.correct', 'production.correct'],
  },
  { capability: 'flow', record: '单据', verb: '改说明', labels: ['编辑', '编辑备注', '写备注'], api: 'POST /flow/:id/info', service: 'updateDocumentInfo', tools: ['flow.edit_info'] },
  { capability: 'flow', record: '单据', verb: '改日期排程', labels: [], api: 'POST /flow/:id/schedule', service: 'schedule', tools: ['flow.schedule'], note: '排程表上拖动日期，没有按钮' },
  { capability: 'flow', record: '送货单', verb: '确认送达', labels: ['确认送达'], api: 'POST /flow/:id/delivered', service: 'markDelivered', tools: ['delivery.mark_delivered'] },
  {
    capability: 'flow',
    record: '完工单',
    verb: '登记完工',
    labels: ['登记完工', '先登记，稍后核对入库'],
    api: 'POST /flow/production-completion/execute',
    previews: ['POST /flow/production-completion/preview'],
    service: 'ManualProductionCompletion.execute',
    tools: ['flow.propose_production_completion'],
  },
  { capability: 'arrival', record: '采购退货', verb: '新建', labels: ['确认退货'], api: 'POST /flow/returns', service: 'PurchaseReturns.create', tools: ['purchase_return.create'] },
  { capability: 'arrival', record: '采购退货', verb: '撤销', labels: ['撤销退货'], api: 'POST /flow/returns/:id/reverse', service: 'PurchaseReturns.reverse', tools: ['purchase_return.reverse'] },
  { capability: 'order-batch', record: '订货单', verb: '登记到货', labels: ['登记到货'], api: 'POST /order-batches/:id/receive', service: 'registerArrival', tools: ['order_batch.receive'] },
  {
    capability: 'order-batch',
    record: '订货单',
    verb: '编辑到货安排',
    labels: ['编辑到货安排', '保存到货安排'],
    api: 'PUT /order-batches/:id/schedule',
    service: 'saveSchedule',
    tools: ['order_batch.schedule'],
  },
  {
    capability: 'order-batch',
    record: '订货单',
    verb: '给一张采购单建订货单',
    labels: [],
    api: 'POST /order-batches/for-purchase/:id',
    service: 'ensureFor',
    note: '采购单详情的订货单一节打开时没有就建，没有按钮',
  },
];

const files: UiAction[] = [
  {
    capability: 'documents',
    record: '导出文件',
    verb: '导出',
    labels: ['导出订货单', '导出送货单', '重新导出订货单', '导出并出库', '只导出文件，不改状态', '导出Word', '导出Excel'],
    api: 'POST /documents',
    previews: ['POST /documents/preview-batch', 'POST /documents/preview-file', 'POST /order-batches/draft'],
    service: 'BusinessDocuments.generate',
    tools: ['documents.export'],
  },
  { capability: 'documents', record: '导出文件', verb: '交付完成', labels: [], api: 'POST /documents/:id/complete', service: 'complete', note: '浏览器下载完文件后自动回执' },
  {
    capability: 'documents',
    record: '单据模板',
    verb: '保存',
    labels: ['保存', '导出测试文件'],
    api: 'POST /documents/templates',
    previews: ['POST /documents/templates/preview', 'POST /documents/templates/sample'],
    service: 'DocumentTemplateSettings.save',
  },
  { capability: 'marks', record: '唛头', verb: '上传', labels: ['上传唛头'], api: 'POST /products/:id/marks/upload', service: 'MarkService.add', tools: ['marks.add'] },
  { capability: 'marks', record: '唛头', verb: '编辑说明', labels: ['编辑说明'], api: 'PUT /marks/:id', service: 'MarkService.update' },
  { capability: 'marks', record: '唛头', verb: '删除', labels: ['删除唛头'], api: 'DELETE /marks/:id', service: 'MarkService.remove', tools: ['marks.remove'] },
  { capability: 'inbox', record: '收件', verb: '粘贴文字', labels: [], api: 'POST /inbox', service: 'InboxService.ingest', tools: ['inbox.add'] },
  { capability: 'inbox', record: '收件', verb: '上传文件', labels: [], api: 'POST /inbox/upload', service: 'InboxService.ingest', tools: ['inbox.add'] },
  { capability: 'inbox', record: '收件', verb: '改处理状态', labels: ['标记已处理', '忽略', '恢复待处理'], api: 'POST /inbox/:id/status', service: 'setStatus', tools: ['inbox.set_status'] },
  { capability: 'inbox', record: '收件', verb: '转进 AI 导入', labels: ['转订单', '转到货'], api: 'POST /inbox/:id/convert', service: 'toImport', tools: ['order_import.from_inbox'] },
  { capability: 'inbox', record: '消息机器人', verb: '保存连接设置', labels: ['保存'], api: 'POST /inbox/bots/:id', service: 'inboxRouter' },
];

const imports: UiAction[] = [
  { capability: 'imports', record: '识别文件', verb: '上传', labels: [], api: 'POST /ai/imports/upload', service: 'importRouter' },
  { capability: 'imports', record: '识别文件', verb: '改识别方式', labels: [], api: 'POST /ai/imports/:id/mode', service: 'setMode' },
  { capability: 'imports', record: '识别文件', verb: '排队识别', labels: ['开始识别'], api: 'POST /ai/imports/:id/enqueue', service: 'enqueue' },
  { capability: 'imports', record: '识别文件', verb: '当场识别', labels: ['重新识别'], api: 'POST /ai/imports/:id/analyze', service: 'analyze', tools: ['order_import.start', 'order_import.retry'] },
  { capability: 'imports', record: '识别文件', verb: '取消识别', labels: ['取消识别'], api: 'POST /ai/imports/:id/cancel', service: 'cancel' },
  { capability: 'imports', record: '识别结果', verb: '改', labels: [], api: 'POST /ai/imports/:id/edit', service: 'edit', tools: ['order_import.edit'] },
  { capability: 'imports', record: '识别结果', verb: '撤回修改', labels: [], api: 'POST /ai/imports/:id/undo', service: 'undo', tools: ['order_import.undo'] },
  { capability: 'imports', record: '识别结果', verb: '匹配档案', labels: ['确认此候选', '重新确认此客户', '重新确认此产品'], api: 'POST /ai/imports/:id/mapping', service: 'mapping', tools: ['order_import.match'] },
  {
    capability: 'imports',
    record: '识别结果',
    verb: '正式导入',
    labels: ['正式导入'],
    api: 'POST /ai/imports/:id/execute',
    previews: ['POST /ai/imports/:id/preview'],
    service: 'execute',
    tools: ['order_import.execute'],
  },
  { capability: 'imports', record: '识别文件', verb: '关联到货单', labels: [], api: 'POST /ai/imports/:id/arrival/link', service: 'linkArrival' },
  { capability: 'arrival', record: '识别文件', verb: '识别到货单', labels: [], api: 'POST /ai/imports/:id/arrival/recognize', service: 'analyze', tools: ['arrival.recognize'] },
  { capability: 'imports', record: '识别文件', verb: '归档或恢复', labels: ['归档', '恢复', '归档文件'], api: 'POST /ai/imports/batch', service: 'changeArchive' },
  { capability: 'imports', record: '识别文件', verb: '永久删除', labels: ['永久删除'], api: 'POST /ai/imports/delete-many', service: 'deleteMany' },
];

/** 财务（server/finance）：财务写入不开放给助手（AGENTS.md），都不写 tools */
const finance: UiAction[] = [
  { capability: 'finance-settings', record: '财务设置', verb: '保存', labels: ['编辑设置', '保存设置'], api: 'PUT /finance/settings', service: 'FinanceSettings.update' },
  { capability: 'finance-settings', record: '科目', verb: '新建或编辑', labels: ['新建科目', '编辑科目', '保存科目'], api: 'PUT /finance/accounts', service: 'FinanceSettings.saveAccount' },
  { capability: 'finance-settings', record: '财务设置', verb: '启用财务', labels: ['启用财务', '确认启用'], api: 'POST /finance/opening/enable', service: 'FinanceSettings.enable', note: '入口在概览、设置页（src/finance/enable.tsx）' },
  { capability: 'finance-ledger', record: '记账模板', verb: '编辑', labels: ['编辑模板', '保存模板'], api: 'PUT /finance/templates', service: 'FinanceTemplates.save' },
  { capability: 'finance-ledger', record: '凭证', verb: '新建', labels: ['新建凭证', '保存凭证'], api: 'POST /finance/vouchers', service: 'FinanceLedger.create' },
  { capability: 'finance-ledger', record: '凭证', verb: '编辑', labels: ['编辑', '保存凭证'], api: 'PUT /finance/vouchers/:id', service: 'FinanceLedger.update' },
  { capability: 'finance-ledger', record: '凭证', verb: '提交审核', labels: ['提交审核', '提交'], api: 'POST /finance/vouchers/:id/submit', service: 'FinanceLedger.transition', note: '列表勾选后“提交（N）”逐张发' },
  { capability: 'finance-ledger', record: '凭证', verb: '审核', labels: ['审核'], api: 'POST /finance/vouchers/:id/approve', service: 'FinanceLedger.transition' },
  { capability: 'finance-ledger', record: '凭证', verb: '记账', labels: ['记账'], api: 'POST /finance/vouchers/:id/post', service: 'FinanceLedger.transition' },
  { capability: 'finance-ledger', record: '凭证', verb: '作废', labels: ['作废', '确认作废'], api: 'POST /finance/vouchers/:id/void', service: 'FinanceLedger.transition' },
  { capability: 'finance-ledger', record: '凭证', verb: '红字冲销', labels: ['红字冲销', '生成冲销凭证'], api: 'POST /finance/vouchers/:id/reverse', service: 'FinanceLedger.reverse', note: '已记账凭证只能红字冲销' },
  {
    capability: 'finance-ledger',
    record: '来源页面生成的凭证',
    verb: '撤回',
    labels: ['撤回'],
    api: 'POST /finance/source-vouchers/:id/withdraw',
    service: 'FinanceDerivedVouchers.withdraw',
    note: '按钮在票据、资产、费用、坏账、利息、保证金的详情里（src/finance/source-voucher.tsx），后面可能拼用途（“撤回坏账”）',
  },
  { capability: 'finance-ledger', record: '来源页面生成的凭证', verb: '红字冲销', labels: ['红字冲销'], api: 'POST /finance/source-vouchers/:id/reverse', service: 'FinanceDerivedVouchers.reverse' },
  { capability: 'finance-flow', record: '业务单据（财务事件）', verb: '补税率', labels: ['保存税率', '填成无税 / 不开票'], api: 'POST /finance/events/:id/resolve', service: 'FinanceEventHandling.resolve', note: '月度台账详情里单张补' },
  {
    capability: 'finance-flow',
    record: '业务单据（财务事件）',
    verb: '批量补税率',
    labels: ['补税率', '保存税率'],
    api: 'POST /finance/tax-completion/batch',
    service: 'FinanceEventHandling.resolveBatch',
    note: '勾选后补选中的，不勾选“补税率（N）”按单位补一个月',
  },
  { capability: 'finance-ledger', record: '业务单据（财务事件）', verb: '生成凭证', labels: ['生成凭证'], api: 'POST /finance/events/:id/generate', service: 'FinanceEventVouchers.generate', note: '列表“生成凭证（N）”逐张发' },
  {
    capability: 'finance-ledger',
    record: '业务单据（财务事件）',
    verb: '红字冲销并重做',
    labels: ['红字冲销并重做', '红字冲销', '确认冲销并重做', '确认红字冲销'],
    api: 'POST /finance/events/:id/correct',
    service: 'FinanceEventHandling.correct',
    note: '单据已撤销、被替代、删除的只红冲不重做，按钮不带“重做”',
  },
  {
    capability: 'finance-ledger',
    record: '业务单据（财务事件）',
    verb: '核对无误',
    labels: ['核对无误', '核对无误，保留凭证'],
    api: 'POST /finance/events/:id/acknowledge',
    service: 'FinanceEventHandling.acknowledgeStatisticalCorrection',
    note: '报表结账的“启用前单据的变动”也用',
  },
  { capability: 'finance-ar', record: '应收应付', verb: '手工新建', labels: ['新建应收', '新建应付'], api: 'POST /finance/obligations', service: 'FinanceParties.create', note: '按钮字由“新建”+应收/应付拼' },
  { capability: 'finance-ar', record: '应收应付', verb: '坏账处理', labels: ['坏账', '确认处理'], api: 'POST /finance/obligations/:id/bad-debt', service: 'FinanceParties.badDebt' },
  { capability: 'finance-ar', record: '应收应付', verb: '多付转抵', labels: ['多付转抵', '确认转抵'], api: 'POST /finance/obligations/transfer-credit', service: 'FinanceAllocations.transferCredit' },
  {
    capability: 'finance-ar',
    record: '往来单位账期',
    verb: '保存',
    labels: ['新建客户账期', '新建供应商账期', '编辑账期', '保存账期'],
    api: 'PUT /finance/party-terms/:id/:id',
    service: 'FinanceParties.saveTerms',
    note: '地址是 /party-terms/:kind/:partyId；新建按钮字由“新建”+客户/供应商+“账期”拼',
  },
  { capability: 'finance-ar', record: '应收应付', verb: '改到期日', labels: ['编辑到期日'], api: 'PUT /finance/obligations/:id/due', service: 'FinanceDue.change', note: '窗口提交按钮是通用“保存”' },
  {
    capability: 'finance-ar',
    record: '应收应付',
    verb: '按新账期重算到期日',
    labels: ['按新账期重算到期日', '确认重算'],
    api: 'POST /finance/due-recalculation',
    previews: ['GET /finance/due-recalculation'],
    service: 'FinanceDue.recalculate',
    note: '先读预览拿摘要，确认时带回',
  },
  { capability: 'finance-ar', record: '对账单', verb: '标记对账状态', labels: ['标记对账状态'], api: 'PUT /finance/statements', service: 'FinanceStatements.mark', note: '窗口提交按钮是通用“保存”' },
  { capability: 'finance-ar', record: '保证金', verb: '新建', labels: ['新建保证金', '保存保证金'], api: 'POST /finance/deposits', service: 'FinanceDepositsInterest.deposit' },
  {
    capability: 'finance-ar',
    record: '保证金',
    verb: '退回或转抵',
    labels: ['退回', '转抵货款', '确认退回', '确认转抵'],
    api: 'POST /finance/deposits/:id/actions',
    service: 'FinanceDepositsInterest.depositAction',
  },
  { capability: 'finance-ar', record: '压款利息', verb: '确认', labels: ['确认利息'], api: 'POST /finance/interest/confirm', service: 'FinanceDepositsInterest.confirmInterest' },
  { capability: 'finance-cash', record: '资金账户', verb: '新建或编辑', labels: ['新建资金账户', '编辑账户', '保存账户'], api: 'PUT /finance/cash/accounts', service: 'FinanceCashAccounts.saveAccount' },
  { capability: 'finance-cash', record: '收付款', verb: '新建或编辑', labels: ['新建收付款', '编辑', '保存收付款'], api: 'PUT /finance/cash/documents', service: 'FinanceSettlements.saveCash' },
  { capability: 'finance-cash', record: '收付款', verb: '确认', labels: ['确认'], api: 'POST /finance/cash/documents/:id/confirm', service: 'FinanceSettlements.confirm', note: '往来类确认时可同时核销' },
  { capability: 'finance-cash', record: '收付款', verb: '撤销', labels: ['撤销', '确认撤销'], api: 'POST /finance/cash/documents/:id/cancel', service: 'FinanceSettlements.cancel' },
  {
    capability: 'finance-cash',
    record: '收付款',
    verb: '核销',
    labels: ['核销'],
    api: 'POST /finance/cash/documents/:id/allocate',
    previews: ['GET /finance/cash/documents/:id/suggestions'],
    service: 'FinanceAllocations.allocate',
  },
  { capability: 'finance-cash', record: '核销', verb: '撤销', labels: ['撤销', '撤销转抵', '确认撤销'], api: 'POST /finance/allocations/:id/revoke', service: 'FinanceAllocations.revoke', note: '多付转抵的转出、转入两笔一起撤' },
  { capability: 'finance-cash', record: '承兑票据', verb: '新建', labels: ['新建票据', '保存票据'], api: 'POST /finance/notes', service: 'FinanceNotes.add' },
  { capability: 'finance-cash', record: '承兑票据', verb: '变更状态', labels: ['变更状态', '确认变更'], api: 'POST /finance/notes/:id/status', service: 'FinanceNotes.change' },
  { capability: 'finance-cash', record: '承兑票据', verb: '核销到欠款', labels: ['核销到欠款'], api: 'POST /finance/notes/:id/allocate', service: 'FinanceNotes.allocate' },
  { capability: 'finance-cash', record: '银行流水', verb: '导入', labels: ['导入银行流水', '导入流水'], api: 'POST /finance/bank/upload', service: 'FinanceBank.upload', note: '收原始字节，经 uploadFile' },
  {
    capability: 'finance-cash',
    record: '银行流水',
    verb: '匹配或解除',
    labels: ['匹配', '解除匹配'],
    api: 'PUT /finance/bank/rows/:id/match',
    previews: ['GET /finance/bank/rows/:id/suggestions'],
    service: 'FinanceBank.match',
  },
  { capability: 'finance-cash', record: '发票', verb: '新建', labels: ['新建发票', '保存发票'], api: 'POST /finance/invoices', service: 'FinanceInvoices.create' },
  { capability: 'finance-cash', record: '发票原件', verb: '上传', labels: ['保存发票'], api: 'POST /finance/attachments/upload', service: 'FinanceAttachments.save', note: '新建发票带了原件时先传，经 uploadFile' },
  { capability: 'finance-cash', record: '发票', verb: '关联单据', labels: ['关联单据'], api: 'PUT /finance/invoices/:id/links', service: 'FinanceInvoices.link', note: '窗口提交按钮是通用“保存”' },
  { capability: 'finance-cash', record: '发票', verb: '确认', labels: ['确认'], api: 'POST /finance/invoices/:id/confirm', service: 'FinanceInvoiceConfirm.confirm', note: '红字发票先选对方科目再确认' },
  { capability: 'finance-cash', record: '发票', verb: '变更状态', labels: ['变更状态'], api: 'POST /finance/invoices/:id/status', service: 'FinanceInvoices.status' },
  { capability: 'finance-costs', record: '费用单', verb: '新建或编辑', labels: ['新建费用单', '编辑', '保存费用单'], api: 'PUT /finance/expenses', service: 'FinanceExpenses.save' },
  {
    capability: 'finance-costs',
    record: '费用单',
    verb: '审批和付款',
    labels: ['提交审批', '批准', '付款', '确认付款', '退回'],
    api: 'POST /finance/expenses/:id/transition',
    service: 'FinanceExpenses.transition',
    note: '正文 action 是 submit / approve / pay / reject，同一个地址',
  },
  { capability: 'finance-costs', record: '员工借还款', verb: '新建', labels: ['新建员工借还款', '保存借还款'], api: 'POST /finance/employee-advances', service: 'FinanceExpenses.advance' },
  { capability: 'finance-costs', record: '固定资产', verb: '新建', labels: ['新建固定资产', '保存资产'], api: 'POST /finance/assets', service: 'FinanceAssets.add' },
  { capability: 'finance-costs', record: '固定资产', verb: '调部门或科目', labels: ['调部门或科目', '保存调整'], api: 'PUT /finance/assets/:id', service: 'FinanceAssets.change' },
  { capability: 'finance-costs', record: '固定资产', verb: '处置', labels: ['处置', '确认处置'], api: 'POST /finance/assets/:id/dispose', service: 'FinanceAssets.dispose' },
  { capability: 'finance-costs', record: '折旧', verb: '计提', labels: ['计提折旧', '重做计提折旧'], api: 'POST /finance/depreciation', service: 'FinanceAssets.depreciate', note: '结账页经 runPeriodJob 也调它' },
  { capability: 'finance-costs', record: '工资表', verb: '导入', labels: ['导入工资表', '重新导入工资表'], api: 'POST /finance/payroll/upload', service: 'FinancePayroll.upload', note: '收原始字节，经 uploadFile' },
  { capability: 'finance-costs', record: '工资', verb: '计提', labels: ['计提工资', '本月没有工资，直接计提', '重做计提工资'], api: 'POST /finance/payroll/confirm', service: 'FinancePayroll.confirm' },
  { capability: 'finance-costs', record: '工资', verb: '发放', labels: ['发放工资', '确认发放'], api: 'POST /finance/payroll/pay', service: 'FinancePayroll.pay' },
  {
    capability: 'finance-costs',
    record: '成本',
    verb: '计算',
    labels: ['计算', '重做'],
    api: 'POST /finance/costing',
    previews: ['GET /finance/costing/requirements'],
    service: 'FinanceCosting.run',
    note: '入口按钮是拼的“计算 YYYY-MM 成本”“重做 YYYY-MM 成本”，结账页是链接“重做成本”',
  },
  { capability: 'finance-reports', record: '预算', verb: '新建或编辑', labels: ['新建预算', '编辑预算', '保存预算'], api: 'PUT /finance/budgets', service: 'FinanceReports.budget' },
  { capability: 'finance-reports', record: '月末结账', verb: '计提税费', labels: ['计提税费', '重做计提税费'], api: 'POST /finance/closing/tax', service: 'FinanceClosing.accrueTax' },
  {
    capability: 'finance-reports',
    record: '月末结账',
    verb: '结转损益',
    labels: ['结转损益', '补做损益结转', '结转年度利润', '补做年度利润结转'],
    api: 'POST /finance/closing/profit',
    service: 'FinanceClosing.settleProfit',
    note: '12 月先损益后年度利润，正文 annual 区分',
  },
  { capability: 'finance-reports', record: '会计期间', verb: '结账', labels: ['结账'], api: 'POST /finance/closing/close', service: 'FinanceClosing.close' },
  { capability: 'finance-reports', record: '会计期间', verb: '反结账', labels: ['反结账', '确认反结账'], api: 'POST /finance/closing/reopen', service: 'FinanceClosing.reopen' },
];

export const uiActions: readonly UiAction[] = [...records, ...flow, ...files, ...imports, ...finance, ...systemActions];
