import { fieldName } from './field-names.js';

/** 不是业务栏目、只在报错里说的几个（业务栏目的叫法查栏目登记表 field-names.ts） */
const systemFieldNames: Record<string, string> = {
  expectedVersion: '记录版本',
  version: '记录版本',
  requestId: '提交编号',
  acknowledged: '操作确认',
  // 登录、改密码、验证本人密码
  password: '密码',
  current: '当前密码',
  // AI 设置（和设置页的叫法一致）
  apiKey: 'DeepSeek 密钥',
  recognitionConcurrency: '同时识别文件数',
  expectedRevision: '版本',
  confirmed: '删除确认',
};
/** 预估成本里的几项：单独出现时（路径里没写上一层）也认 */
const costKeys = new Set(['material', 'processing', 'waste', 'other', 'basis']);
const costName = (key: string) => (costKeys.has(key) ? fieldName(key, { parent: 'costs' }) : undefined);
/**
 * 校验路径里一段字段名的界面叫法。alone 为真时这个名字自己就说清了是哪一项（预估成本里的“加工成本”），
 * 不再带上一层的名字。数据管理按自己编辑窗的叫法另传一个（server/admin/data-management-service.ts）。
 */
export type FieldNamer = (key: string, parent: string) => { label: string; alone?: boolean };
/** 查叫法表：只认表里自己写的名字（toString、constructor 这类对象自带的不算，免得把函数源码拼进提示） */
const nameIn = (table: Record<string, string>, key: string) => (Object.hasOwn(table, key) ? table[key] : undefined);
/** 字段代码的叫法：业务栏目按登记表的基本叫法，再查系统字段 */
const plainName = (key: string) => fieldName(key) ?? nameIn(systemFieldNames, key);
/**
 * 按栏目登记表说字段：知道是哪种记录（采购单、送货单……）时按那种记录的叫法（采购日期、收货地址），
 * 明细一层按明细的叫法（本单名称、订货数量），不知道的按基本叫法。
 */
export const fieldNamer =
  (record?: string): FieldNamer =>
  (key, parent) => {
    const cost = parent === 'costs' ? costName(key) : undefined;
    if (cost) return { label: cost, alone: true };
    // 上一层下面另起了名字的（纸板资料里的“纸板名称”），名字自己就说清了，不再接上一层的“纸板”
    const nested = parent ? fieldName(key, { parent }) : undefined;
    if (nested && nested !== fieldName(key)) return { label: fieldName(key, { record, parent }) ?? nested, alone: true };
    return { label: fieldName(key, { record, parent }) ?? plainName(key) ?? costName(key) ?? key };
  };
const defaultNamer = fieldNamer();
const isIndex = (segment: string) => /^\d+$/.test(segment);
/**
 * 校验路径（lines.0.productId）→ 界面上的说法（明细第1项的产品）：
 * - 数组下标写“第N项”，接在数组名后面；没有中文名的数组名（items 这类）不说，只说第几项；
 * - 有自己叫法的（alone）顶掉上一层的名字；几层之间用“的”连。
 */
function issueLabel(path: string, name: FieldNamer) {
  const segments = path ? path.split('.') : [],
    parts: string[] = [];
  let parent = '',
    named = false,
    afterIndex = false;
  segments.forEach((segment, i) => {
    if (isIndex(segment)) {
      const row = '第' + (Number(segment) + 1) + '项';
      if (named) parts[parts.length - 1] += row;
      else parts.push(row);
      named = false;
      afterIndex = true;
      return;
    }
    const { label, alone } = name(segment, parent);
    if (label === segment && isIndex(segments[i + 1] || '')) named = false;
    else {
      if (alone && parent && !afterIndex && parts.length) parts[parts.length - 1] = label;
      else parts.push(label);
      named = true;
    }
    parent = segment;
    afterIndex = false;
  });
  return parts.join('的');
}
/** 一条“字段路径: 提示”（server/app.ts 和各处把校验错误写成这样）：路径只认字段名和下标 */
const pathIssue = /^((?:\d+|[A-Za-z_]\w*)(?:\.(?:\d+|[A-Za-z_]\w*))*)?: ([\s\S]+)$/;
/**
 * 给人看的报错：全站一个写法（服务端 server/app.ts 统一处理校验错误、页面显示服务端报错、数据管理都走这里）。
 * - 几条用“；”隔开，逐条处理；
 * - “字段路径: 提示”写成“界面叫法：提示”（中文冒号，“明细第2项的数量：……”“加工成本：……”），
 *   提示末尾的标点去掉，免得连起来出现“。；”；不在末尾补句号（页面会把几条再连起来）；
 * - 别的文字照老办法换掉字段代码和英文默认提示；已经是中文的原样返回，处理两遍结果一样。
 * name 是字段叫法，默认用上面的表；数据管理传自己编辑窗的叫法。
 */
export function userError(message: string, name: FieldNamer = defaultNamer) {
  return message
    .split('；')
    .map((segment) => {
      const issue = pathIssue.exec(segment);
      if (!issue) return plainText(segment);
      const label = issueLabel(issue[1] || '', name),
        reason = plainText(issue[2]).trim().replace(/[。；;.，,\s]+$/u, '');
      return (label ? label + '：' : '') + reason;
    })
    .join('；');
}
/** 不是“路径: 提示”的文字：老办法，把明细路径、字段代码、zod 的英文默认提示换成中文 */
function plainText(message: string) {
  return message
    .replace(
      /\b(?:lines|items|materials|quantities)\.(\d+)\./g,
      (_, i) => '第' + (Number(i) + 1) + '项 ',
    )
    // 预估成本里的几项按整条路径换名：material 单独出现时指“材质 / 配纸”，在预估成本里是“材料成本”
    .replace(/\bcosts\.(material|processing|waste|other|basis)\b/g, (s, key: string) => costName(key) || s)
    .replace(/\b[A-Za-z][A-Za-z0-9_]*\b/g, (s) => plainName(s) || costName(s) || s)
    // 选择项（客户、订单明细、库存品……）没选时值是 null
    .replace(/Invalid input: expected number, received null/g, '还没选')
    .replace(
      /Invalid input: expected number, received (?:NaN|undefined|string)/g,
      '请填写有效数值',
    )
    .replace(/Too small: expected array to have >=1 items?/g, '至少要有一行')
    .replace(
      /Invalid input: expected string, received (?:undefined|null|number)/g,
      '请填写文字内容',
    )
    .replace(/Invalid input: expected true/g, '请核对并确认操作')
    // 数字范围（同时识别文件数这类）：先换带等号的
    .replace(/Too big: expected number to be <=(-?[\d.]+)/g, '不能大于$1')
    .replace(/Too small: expected number to be >=(-?[\d.]+)/g, '不能小于$1')
    .replace(/Too big: expected number to be <(-?[\d.]+)/g, '要小于$1')
    .replace(/Too small: expected number to be >(-?[\d.]+)/g, '要大于$1')
    .replace(/Too small: expected string to have >=(\d+) characters/g, '至少需要$1个字符')
    .replace(/Too big: expected string to have <=(\d+) characters/g, '不能超过$1个字符');
}
