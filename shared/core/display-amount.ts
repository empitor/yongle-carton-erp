// 只修剪显示尾零，不改变数值或舍入有效小数；数据库精度保持原样。
export function displayAmount(value: string) {
  // 负号单独处理：-0.50 的整数部分是 -0，BigInt 后就是 0，负号会丢。
  const negative = value.startsWith('-');
  const [integer, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const shown = fraction.replace(/0+$/, '');
  const zero = !/[1-9]/.test(integer + shown);
  return (
    (negative && !zero ? '-' : '') +
    BigInt(integer).toLocaleString('zh-CN') +
    '.' +
    shown.padEnd(2, '0')
  );
}

/**
 * 以分存的整数金额写成“1,234.50”（千分位、两位小数），不经过浮点乘除出尾差。
 * 不是整数的四舍五入到分；不是数（NaN、null）按 0。缺值要写“—”的由调用方先判断（src/ui/money.ts 的 yuan）。
 */
export function centsText(cents: number) {
  const n = Math.round(Number(cents) || 0),
    sign = n < 0 ? '-' : '',
    abs = Math.abs(n);
  return sign + Math.floor(abs / 100).toLocaleString('zh-CN') + '.' + String(abs % 100).padStart(2, '0');
}

const upperDigits = '零壹贰叁肆伍陆柒捌玖',
  upperUnits = ['', '拾', '佰', '仟'],
  upperGroups = ['', '万', '亿', '万亿'];
/** 每四位一组（个、万、亿、万亿）；整数部分最多写到万亿那一组 */
const GROUP_DIGITS = 4;
const MAX_INTEGER_DIGITS = 16;

/** 整数部分的大写（不带“元”）：中间的零按读法补一个“零”，万、亿按每四位一组加（这一组全是零就不加） */
function upperInteger(integer: string) {
  let out = '',
    zero = false;
  for (let i = 0; i < integer.length; i++) {
    const d = Number(integer[i]),
      pos = integer.length - 1 - i;
    if (d === 0) zero = true;
    else {
      out += (zero && out ? '零' : '') + upperDigits[d] + upperUnits[pos % GROUP_DIGITS];
      zero = false;
    }
    if (pos % GROUP_DIGITS === 0 && pos > 0 && /[1-9]/.test(integer.slice(Math.max(0, i - GROUP_DIGITS + 1), i + 1)))
      out += upperGroups[pos / GROUP_DIGITS];
  }
  return out;
}
/**
 * 人民币大写金额。只写到分；分以下还有非零数字、负数或格式不对时返回 null，
 * 由调用方只印小写，不四舍五入。
 */
export function uppercaseAmount(value: string): string | null {
  const m = value.replaceAll(',', '').trim().match(/^(\d+)(?:\.(\d*))?$/);
  if (!m) return null;
  const fraction = (m[2] || '').replace(/0+$/, ''),
    integer = m[1].replace(/^0+(?=\d)/, '');
  if (fraction.length > 2 || integer.length > MAX_INTEGER_DIGITS) return null;
  const out = upperInteger(integer);
  const jiao = Number(fraction[0] || 0),
    fen = Number(fraction[1] || 0);
  if (!jiao && !fen) return (out || '零') + '元整';
  return (
    (out ? out + '元' : '') +
    (jiao ? upperDigits[jiao] + '角' : out ? '零' : '') +
    (fen ? upperDigits[fen] + '分' : '整')
  );
}
