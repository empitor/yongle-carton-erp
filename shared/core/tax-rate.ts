import { z } from 'zod';

/** 百分数最多两位小数；库里以整数万分比保存。 */
const BP_PER_PERCENT = 100;
const FULLWIDTH_ASCII_OFFSET = 0xfee0;
export const MAX_TAX_PERCENT = 100;
export const TAX_PERCENT_STEP = 1 / BP_PER_PERCENT;
const rateMessage = '请填写 0 到 100 之间、最多两位小数的税率';

export const taxRateSchema = z.number({ error: rateMessage }).min(0, rateMessage).max(MAX_TAX_PERCENT, rateMessage)
  .refine((rate) => percentFromTaxRateBp(taxRateToBp(rate)) === rate, rateMessage);

export const taxRateToBp = (percent: number) => Math.round(percent * BP_PER_PERCENT);
export const percentFromTaxRateBp = (bp: number) => bp / BP_PER_PERCENT;

/** 只认明确的百分数。没写百分号的小数 0 < n < 1 有歧义，保留原文交给人核对。 */
export function readTaxRate(text: string | null | undefined): number | null {
  const normalized = text
    ?.replace(/[０-９％．]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - FULLWIDTH_ASCII_OFFSET))
    .replace(/\s/g, '');
  const match = /^(\d+)(?:\.(\d{1,2}))?(%)?$/.exec(normalized ?? '');
  if (!match) return null;
  const whole = Number(match[1]), fraction = Number((match[2] ?? '').padEnd(2, '0'));
  if (whole === 0 && fraction > 0 && !match[3]) return null;
  const bp = whole * BP_PER_PERCENT + fraction;
  return bp <= MAX_TAX_PERCENT * BP_PER_PERCENT ? bp : null;
}

type Text = string | null | undefined;
/** 现在填的税率（页面里是文字，空着是空串） */
type Filled = number | string | null | undefined;
/** 第 24 步升级把认不出的旧含税口径接在税率原话后面：另起一行，“口径：”加逐字的原写法（server/core/schema/steps.ts 的 v24Text） */
const MODE_NOTE = '口径：';
/** 原话分两段：前面是税率原话，从“口径：”开头的那一行起到末尾是口径原话（原写法里带换行也整段算口径） */
function textParts(text: Text) {
  const lines = (text ?? '').split('\n'),
    at = lines.findIndex((line) => line.startsWith(MODE_NOTE));
  const cut = at < 0 ? lines.length : at;
  return { rate: lines.slice(0, cut).join('\n'), note: lines.slice(cut).join('\n') };
}
/** taxText 里的税率原话：“口径：…”前面的全文（和第 24 步一样按全文认，不只看第一行） */
const rateText = (text: Text) => textParts(text).rate.trim();
/** taxText 里第 24 步记下的认不出的旧含税口径原话；没有是空串 */
const modeText = (text: Text) => textParts(text).note.slice(MODE_NOTE.length).trim();
const unset = (value: Filled) => value == null || value === '';
/** 规范税率没填、原话里的税率又认不出：那段原话；否则空串 */
function unrecognizedRate(text: Text, rate: Filled) {
  const raw = unset(rate) ? rateText(text) : '';
  return raw && readTaxRate(raw) === null ? raw : '';
}
/** 规范口径没选、原话里有认不出的旧口径：那段原话；否则空串 */
const unrecognizedMode = (text: Text, mode: Text) => (unset(mode) ? modeText(text) : '');

/** 显式清空已有规范税率时，清掉原话里可识别的旧税率，保留认不出的税率原话和“口径：…”那一段。 */
export function clearRecognizedTaxText(text: Text): string | null {
  const rate = rateText(text);
  const kept = [rate && readTaxRate(rate) === null ? rate : '', textParts(text).note];
  return kept.filter(Boolean).join('\n') || null;
}

/** 规范税率写进单据的样子：0 < 税率 < 1 保留 % 以区别于歧义小数，其余不带 % */
const documentRate = (rate: number) => (rate > 0 && rate < 1 ? `${rate}%` : String(rate));

/**
 * 送货单抄订单（或订单明细）这一层的税费，没有的项不写（送货按明细、整单的顺序各取第一个有的）：
 * - 税率：规范税率照 documentRate 写；空着只抄认不出的税率原话。
 * - 含税口径：规范口径照抄；空着、原话里有“口径：…”的，连“口径：”一起抄（哪怕后面写的是“含税”），
 *   财务一律认不出、记“资料待补”，等人在下拉里选；不退到整单或往来单位的默认。
 */
export function orderTaxSnapshot(tax: { taxRate?: number | null; taxMode?: string | null; taxText?: Text }) {
  const note = modeText(tax.taxText);
  return {
    taxRate: tax.taxRate == null ? unrecognizedRate(tax.taxText, null) || undefined : documentRate(tax.taxRate),
    taxMode: tax.taxMode || (note ? MODE_NOTE + note : undefined),
  };
}

/** 单据快照里含税口径的原写法给人看：orderTaxSnapshot 抄的“口径：…”去掉前缀和首尾空白，别的照原样（去首尾空白） */
export function snapshotModeOriginal(mode: string) {
  const shown = mode.trim();
  return (shown.startsWith(MODE_NOTE) ? shown.slice(MODE_NOTE.length) : shown).trim();
}

export const shownTaxRate = (rate: number | null | undefined) => rate == null ? '' : rate + '%';

/**
 * 税费要不要人核对：规范税率没填、原话里的税率认不出，或者规范口径没选、原话里有认不出的旧口径（“口径：…”）。
 * rate、mode 是现在填的税率和选的含税口径，不传当没填。
 */
export function hasUnrecognizedTax(text: Text, rate?: Filled, mode?: Text) {
  return Boolean(unrecognizedRate(text, rate) || unrecognizedMode(text, mode));
}

/** 没认出来的那项、原件写的是什么；能改的地方（编辑窗、识别结果）再接一句叫人填，只读的地方就到这为止 */
const rateUnread = (raw: string) => `税率没认出来，原件写的是“${raw}”`;
const modeUnread = (raw: string) => `含税口径没认出来，原件写的是“${raw}”`;

/**
 * 税率格下面的一句（编辑窗；识别结果的税率也用它），只说原话里税率那段：没认出来时叫人填，
 * 认得出就列出税率那段原话，没有税率那段不写。口径那段只在含税口径格说（orderTaxModeHint）。
 */
export function orderTaxRateHint(text: Text, rate?: Filled) {
  const raw = rateText(text),
    bad = unrecognizedRate(text, rate);
  if (bad) return rateUnread(bad) + '，请选择或填写税率。';
  return raw ? `原件写法：${raw}` : '';
}

/** 编辑窗含税口径格下面的一句：口径没选、原话里有认不出的旧口径时说原件写的是什么、叫人选，否则没有 */
export function orderTaxModeHint(text: Text, mode?: Text) {
  const bad = unrecognizedMode(text, mode);
  return bad ? modeUnread(bad) + '，请选择含税口径。' : '';
}

/**
 * 一行写完的税费原件写法（订单详情、卡片、修改历史，都是只读的）：没认出来的几项各说一句是什么，不叫人去选；
 * 都认得出就原样列出。rate、mode 同上。
 */
export function orderTaxOriginal(text: Text, rate?: Filled, mode?: Text) {
  if (!text?.trim()) return '';
  const badRate = unrecognizedRate(text, rate),
    badMode = unrecognizedMode(text, mode);
  const notes = [badRate && rateUnread(badRate) + '。', badMode && modeUnread(badMode) + '。'];
  return notes.filter(Boolean).join('') || `原件写法：${text}`;
}
