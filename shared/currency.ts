// 仅规范人民币的明确等价表示，不换汇、不把未知的非空货币当成人民币。
export function inspectCurrency(value: unknown) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const normalized = raw.normalize('NFKC').replace(/\s+/g, '').toUpperCase();
  const absent =
    value === null ||
    value === undefined ||
    (typeof value === 'string' &&
      ['', '未注明', '未标注', '未明确', '未提供', '未知', '待确认', 'N/A'].includes(normalized));
  // 允许“人民币(CNY)”“RMB/¥”等仅由人民币标记组成的写法；任何外币文字/符号均会留下残余并被拒绝。
  const tokens = /CNY|RMB|人民币|CN¥|元|¥/g;
  const remainder = normalized.replace(tokens, '');
  const equivalent = remainder !== normalized && remainder.replace(/[()/·]/g, '') === '';
  const supported = absent || (typeof value === 'string' && equivalent);
  return {
    raw,
    currency: supported ? ('CNY' as const) : null,
    defaulted: absent,
    message: supported
      ? absent
        ? '原订单未注明币种，本次按人民币（CNY）默认保存；未进行汇率换算，请人工核对。'
        : null
      : '当前正式订单仅支持人民币（CNY）。原币种“' +
        (raw || '无效值') +
        '”无法自动转换，请核对原订单；若确为外币，请保留草稿，暂勿导入。',
  };
}
export function canonicalCurrency(value: unknown): unknown {
  const result = inspectCurrency(value);
  return result.currency ?? value;
}
