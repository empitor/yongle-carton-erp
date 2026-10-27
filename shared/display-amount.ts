// 只修剪显示尾零，不改变数值或舍入有效小数；数据库精度保持原样。
export function displayAmount(value: string) {
  const [integer, fraction = ''] = value.split('.');
  return BigInt(integer).toLocaleString('zh-CN') + '.' + fraction.replace(/0+$/, '').padEnd(2, '0');
}
