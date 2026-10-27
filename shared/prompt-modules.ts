/**
 * 识别提示词模块的前后端共享元数据。
 * 只放模块身份和展示信息，不引用服务端实现；每个模块的提示词仍由现有
 * PromptPresetManager 按模块标识/files 隔离，避免改动既有提示词存储架构。
 */
export type PromptModulePurpose = 'recognition' | 'assistant';
export type PromptModuleStatus = 'active' | 'planned' | 'generation';
export type PromptModuleId =
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
    usage: '入口：AI 智能订单导入（已接入）',
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
    usage: '入口：采购到货页面的供应商送货单 AI 识别（已接入）',
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
    description: '全局业务助手的独立提示词与回复规则；工具、权限和业务校验仍由后端固定控制。',
    purpose: 'assistant',
    apiPath: '/api/ai/prompt-modules/assistant',
    storageFile: 'assistant.sqlite',
    status: 'active',
    documents: '全局 AI 助手对话',
    usage: '入口：全局 AI 助手（已接入）',
  },
];
export function getPromptModule(id: string) {
  return promptModules.find((module) => module.id === id);
}
