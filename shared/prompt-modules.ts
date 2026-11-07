/**
 * 识别提示词模块的前后端共享元数据。
 * 只放模块身份和展示信息，不引用服务端实现；每个模块的提示词仍由现有
 * PromptPresetManager 按模块标识/files 隔离，避免改动既有提示词存储架构。
 */
export type PromptModulePurpose = 'recognition' | 'assistant';
export type PromptModuleStatus = 'active' | 'planned' | 'generation';
export type PromptModuleId =
  | 'shipping-mark'
  | 'sales-order'
  | 'purchase-order'
  | 'supplier-delivery'
  | 'customer-delivery'
  | 'assistant';
export type PromptModuleDefinition = {
  id: PromptModuleId;
  name: string;
  description: string;
  purpose: PromptModulePurpose;
  apiPath: string;
  storageFile: string;
  status: PromptModuleStatus;
  documents: string;
  usage: string;
};
export const promptModules: PromptModuleDefinition[] = [
  { id: 'shipping-mark', name: '唛头识别', description: '识别并归档产品参考唛头，不产生订单、生产或库存。', purpose: 'recognition', apiPath: '/api/ai/prompt-modules/shipping-mark', storageFile: 'shipping-marks.sqlite', status: 'active', documents: '客户唛头、样稿、印刷文件', usage: '入口：AI 导入，类型选唛头（已接入）' },
  {
    id: 'sales-order',
    name: '客户订单识别',
    description:
      '识别客户订货单、采购订单或购销合同，按客户订单草稿核对后进入正式订单导入。',
    purpose: 'recognition',
    apiPath: '/api/ai/prompt-modules/sales-order',
    storageFile: 'presets.sqlite',
    status: 'active',
    documents: '客户订货单、客户采购订单、购销合同',
    usage: '入口：AI 导入，类型选客户订单（已接入）',
  },
  {
    id: 'purchase-order',
    name: '供应商采购订单识别',
    description:
      '供全局助手以后生成我方发给供应商的采购订单（采购草稿）；不提供外部单据识别入口。',
    purpose: 'recognition',
    apiPath: '/api/ai/prompt-modules/purchase-order',
    storageFile: 'purchase-orders.sqlite',
    status: 'generation',
    documents: '纸板订货单、物料采购订单（我方发供应商）',
    usage: '用途：供全局助手生成我方采购订单（助手升级后接入）',
  },
  {
    id: 'supplier-delivery',
    name: '供应商到货单识别',
    description: '识别供应商送货单/到货单，生成到货草稿并可匹配采购单；允许合理的无采购单到货。',
    purpose: 'recognition',
    apiPath: '/api/ai/prompt-modules/supplier-delivery',
    storageFile: 'receipts.sqlite',
    status: 'active',
    documents: '供应商送货单、纸板到货单',
    usage: '入口：AI 导入类型选到货单，或到货页的 AI 收货（已接入）',
  },
  {
    id: 'customer-delivery',
    name: '客户送货单识别',
    description:
      '供全局助手以后生成我方发给客户的送货单（含客户仓库入库/送检格式）；不提供外部单据识别入口。',
    purpose: 'recognition',
    apiPath: '/api/ai/prompt-modules/customer-delivery',
    storageFile: 'customer-deliveries.sqlite',
    status: 'generation',
    documents: '我方客户送货单、客户仓库入库/送检格式的收货凭证',
    usage: '用途：供全局助手生成我方客户送货单（助手升级后接入）',
  },
  {
    id: 'assistant',
    name: '全局助手提示词',
    description: '小甬和小勒的性格、分工和业务规则；回复格式、工具、权限和业务校验由后端固定控制。',
    purpose: 'assistant',
    apiPath: '/api/ai/prompt-modules/assistant',
    storageFile: 'assistant.sqlite',
    status: 'active',
    documents: '全局 AI 助手对话',
    usage: '入口：右上角 AI 助手，Ctrl+J（已接入）',
  },
];
export function getPromptModule(id: string) {
  return promptModules.find((module) => module.id === id);
}
