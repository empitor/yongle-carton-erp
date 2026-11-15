// real-suite-files.mjs 里给 server.mts 用到的那部分的类型（预览实例的收件箱种子要一份合法的虚构 xlsx）。
export const FILES: {
  /** 脚本现造的虚构客户订单表格 */
  orderXlsx(options?: { customer?: string; noDate?: boolean; po?: string }): Promise<{ name: string; bytes: Uint8Array }>;
};
