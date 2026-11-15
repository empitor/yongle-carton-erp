/**
 * 提示词模块的前后端共享元数据：只放模块身份和展示信息，不引用服务端实现。
 * 每个模块一个提示词库文件（storageFile），由 PromptPresetManager 管。
 * 只列真正会发给模型的模块；“供应商采购订单”“客户送货单”两个从没接上的模块 0.9.0 删了。
 */
export type PromptModulePurpose = 'recognition' | 'assistant';
export type PromptModuleStatus = 'active';
export type PromptModuleId = 'sales-order' | 'supplier-delivery' | 'assistant';
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
      '识别客户订货单、采购订单或购销合同，按订单识别结果核对后进入正式订单导入。',
    purpose: 'recognition',
    apiPath: '/api/ai/prompt-modules/sales-order',
    storageFile: 'presets.sqlite',
    status: 'active',
    documents: '客户订货单、客户采购订单、购销合同',
    usage: '入口：AI 导入，类型选客户订单',
  },
  {
    id: 'supplier-delivery',
    name: '供应商到货单识别',
    description: '识别供应商送货单/到货单，生成待核对的到货识别结果并可匹配采购单；允许合理的无采购单到货。',
    purpose: 'recognition',
    apiPath: '/api/ai/prompt-modules/supplier-delivery',
    storageFile: 'receipts.sqlite',
    status: 'active',
    documents: '供应商送货单、纸板到货单',
    usage: '入口：AI 导入类型选到货单，或到货页的“AI 识别送货单”',
  },
  {
    id: 'assistant',
    name: '小甬小勒提示词',
    description: '小甬和小勒的性格、分工和业务规则；回复格式、工具、权限和业务校验由后端固定控制。',
    purpose: 'assistant',
    apiPath: '/api/ai/prompt-modules/assistant',
    storageFile: 'assistant.sqlite',
    status: 'active',
    documents: '小甬小勒对话',
    usage: '入口：右下角小甬小勒或顶栏入口，Ctrl+J',
  },
];
