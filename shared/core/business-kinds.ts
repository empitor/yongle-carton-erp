/**
 * 库存品和业务单据的种类取值：共用-基础（页面地址册子）和共用-业务共用这一份定义，
 * 财务、识别导入等只能依赖共用-基础的模块也能直接引用。
 */
export const stockKinds = ['raw', 'finished'] as const;
export type StockKind = (typeof stockKinds)[number];

export const flowKinds = ['arrival', 'task', 'production', 'delivery'] as const;
export type FlowKind = (typeof flowKinds)[number];

/** 是不是四种单据之一（到货、生产任务、完工、送货） */
export const isFlowKind = (kind: unknown): kind is FlowKind => flowKinds.some((k) => k === kind);
