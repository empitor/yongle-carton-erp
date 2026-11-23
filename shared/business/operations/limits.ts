import { PRICE_DECIMALS, QUANTITY_DECIMALS } from '../../core/index.js';

/**
 * 本模块几处共用的数：输入文字的长度上限，金额、面积的小数位数。同一个数只在这里定义一处；
 * 数量、单价的小数位数在 shared/core（quantity.ts、precision.ts），这里由它们算出来。
 */
/** 说明类文字（备注、规格说明、原因、地址、联系人）最多多少字 */
export const NOTE_MAX_LENGTH = 2000;
/** 列表筛选里的关键字、名称最多多少字 */
export const SEARCH_MAX_LENGTH = 200;
/** 数量单位最多多少字 */
export const UNIT_MAX_LENGTH = 20;
/** 一张订货单的到货安排最多几段（改到货安排、导出订货单、助手传的都按它） */
export const MAX_SCHEDULE_ENTRIES = 500;
/** 一次登记到货最多几行 */
export const MAX_RECEIVE_ROWS = 200;
/** 数量 × 单价的精确金额：七位小数 */
export const MONEY_DECIMALS = QUANTITY_DECIMALS + PRICE_DECIMALS;
/** 长 × 宽按平方毫米、平方厘米算出来，换成平方米要往左挪几位小数 */
export const SQUARE_METRE_SHIFT = { mm: 6, cm: 4 } as const;
