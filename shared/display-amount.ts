// 只修剪显示尾零，不改变数值或舍入有效小数；数据库精度保持原样。
export function displayAmount(value: string) {
  const [integer, fraction = ''] = value.split('.');
  return BigInt(integer).toLocaleString('zh-CN') + '.' + fraction.replace(/0+$/, '').padEnd(2, '0');
}

const upperDigits = '零壹贰叁肆伍陆柒捌玖',
  upperUnits = ['', '拾', '佰', '仟'],
  upperGroups = ['', '万', '亿', '万亿'];
/**
 * 人民币大写金额。只写到分；分以下还有非零数字、负数或格式不对时返回 null，
 * 由调用方只印小写，不四舍五入。
 */
export function uppercaseAmount(value: string): string | null {
  const m = value.replaceAll(',', '').trim().match(/^(\d+)(?:\.(\d*))?$/);
  if (!m) return null;
  const fraction = (m[2] || '').replace(/0+$/, ''),
    integer = m[1].replace(/^0+(?=\d)/, '');
  if (fraction.length > 2 || integer.length > 16) return null;
  let out = '',
    zero = false;
  for (let i = 0; i < integer.length; i++) {
    const d = Number(integer[i]),
      pos = integer.length - 1 - i;
    if (d === 0) zero = true;
    else {
      out += (zero && out ? '零' : '') + upperDigits[d] + upperUnits[pos % 4];
      zero = false;
    }
    if (pos % 4 === 0 && pos > 0 && /[1-9]/.test(integer.slice(Math.max(0, i - 3), i + 1)))
      out += upperGroups[pos / 4];
  }
  const jiao = Number(fraction[0] || 0),
    fen = Number(fraction[1] || 0);
  if (!jiao && !fen) return (out || '零') + '元整';
  return (
    (out ? out + '元' : '') +
    (jiao ? upperDigits[jiao] + '角' : out ? '零' : '') +
    (fen ? upperDigits[fen] + '分' : '整')
  );
}
