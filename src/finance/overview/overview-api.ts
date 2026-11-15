import { finRead, type FinRequest } from '../fin-api';

/* 概览的读法：经营明细的列表（FinList 按它翻页）。这页别的数在页面里用 useFinRead 直接读。 */

type DetailQuery = FinRequest<'GET /finance/monthly-report/detail'>[1]['query'];

/** 经营明细的一页：哪个月、哪项金额、哪个单据月份，第几页 */
export const listMonthlyDetail = (query: DetailQuery) => finRead('GET /finance/monthly-report/detail', { query });
