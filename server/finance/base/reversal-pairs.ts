/**
 * 红字冲销的往来成对看。
 *
 * 送货、到货撤销或改了内容后，在财务待处理里“红字冲销并重做”：红冲原凭证，同时记一笔冲销往来
 * （fin_obligations.reversal_of 指向原往来，金额是负数，voucher_id 是那张红字凭证）。
 * 红字凭证没作废（待记账也算）冲销就成立；作废了冲销不成立，原往来照常显示、照常收付。
 *
 * 成立时两笔合起来看：合计余额 = 原往来金额 - 原往来已核销 + 冲销金额（负数）- 冲销往来已核销（正常是 0）。
 * 逐笔列表里冲销那笔余额记 0，合计余额记在原往来上：等于 0 是“已冲销”，两笔都不欠不多；
 * 小于 0 是冲销前已经收付过的钱，冲销后成了对方多付，原往来显示“多付”，可以多付转抵（钱的核销挂在原往来上）。
 * 到期、账龄、催款、可核销的往来都只认余额大于 0 的，这两笔都进不去；
 * 那些读取原来按“原往来和它的冲销往来都排除”写，和这里是同一个口径。
 */

/** 往来 o（表别名）上成立的冲销往来，作为 EXISTS / IN 的子查询；extra 是追加条件，比如截止日期。 */
export const activeReversals = (o: string, extra = '') =>
  `SELECT r.id FROM fin_obligations r JOIN fin_vouchers rv ON rv.id=r.voucher_id
    WHERE r.reversal_of=${o}.id AND rv.status<>'void'${extra}`;

/**
 * 往来 o 已被成立的冲销往来冲掉（条件）。判断“往来有没有被冲销”都用它，不另写一份；
 * extra 用法同上，账龄按已记账、截至日期看时传 " AND rv.status='posted' AND r.date<=?"。
 */
export const isReversed = (o: string, extra = '') => `EXISTS(${activeReversals(o, extra)})`;

/** 往来 o 被成立的冲销往来冲掉的金额（分，负数）；没冲销是 0。 */
export const reversedCents = (o: string, extra = '') =>
  `coalesce((SELECT sum(r.amount_cents) FROM fin_obligations r JOIN fin_vouchers rv ON rv.id=r.voucher_id
    WHERE r.reversal_of=${o}.id AND rv.status<>'void'${extra}),0)`;

/** 往来 o 的冲销关系：冲销往来本身是 'reversal'，被成立的冲销冲掉的原往来是 'reversed'，别的是 NULL。 */
export const reversalState = (o: string) =>
  `CASE WHEN ${o}.reversal_of IS NOT NULL THEN 'reversal'
    WHEN ${isReversed(o)} THEN 'reversed' END`;

/** 冲销往来 r 冲的是哪张单据：“送货单 SH-…”“到货单 DH-…”；原往来没有来源单据号时是 NULL。对账单这类外发的地方用它，不用冲销原因。 */
export const reversedDocument = (r: string) =>
  `(SELECT CASE WHEN x.kind='receivable' THEN '送货单 ' ELSE '到货单 ' END||
    ev.source_number
    FROM fin_obligations x JOIN fin_events ev ON ev.id=x.event_id WHERE x.id=${r}.reversal_of)`;

/**
 * 往来 o 是单据改过、红字冲销后按新内容重记的那笔：同一条财务事件名下先有一笔成立的冲销往来（冲的是更早的那笔），
 * 之后才记的它。按关系推，不看摘要文字，老记录也认得出。
 */
export const isRerecorded = (o: string) =>
  `(${o}.reversal_of IS NULL AND ${o}.event_id IS NOT NULL AND EXISTS(SELECT 1 FROM fin_obligations rr
    JOIN fin_vouchers rrv ON rrv.id=rr.voucher_id WHERE rr.event_id=${o}.event_id AND rr.reversal_of IS NOT NULL
    AND rr.reversal_of<>${o}.id AND rr.id<${o}.id AND rrv.status<>'void'))`;

/**
 * 冲销链：同一张单据红字冲销并重做以后又冲销、再重做，几笔往来连成一条链（原来那笔 → 冲销 1 → 重记 1 → 冲销 2 → 重记 2 …）。
 * 每笔往来的上一环：冲销往来是它冲的那笔（reversal_of，红字凭证作废的不算）；重记的那笔是同一条财务事件名下、
 * 在它之前最近一笔成立的冲销所冲的那笔（和 isRerecorded 同一个判断）。上一环的编号总比自己小，所以链头就是往上走到的最小编号。
 *
 * 返回 WITH RECURSIVE 里用的三个 CTE（调用方自己写 WITH RECURSIVE），kind 参数占一个 “?”：
 * - fin_chain_link(id, prev)：有上一环的往来；
 * - fin_chain_root(id, root)：有上一环的往来和它所在链的链头（链头自己不在 id 里，用 coalesce(root, 自己) 补）。
 * 在数据库里一次算完，不逐条查、不读到程序里再找。
 * 往上走的每一步都要求上一环编号更小（l.prev < w.cur）：现有写入路径下本来就是这样，结果不变；
 * 只是万一库里出现环（手工改库、以后的新写入路径），递归也一定会停，不会把逐笔、对账单卡死。
 */
export const chainCtes = () => `fin_chain_link(id,prev) AS MATERIALIZED (
    SELECT id,prev FROM (SELECT o.id,CASE WHEN o.reversal_of IS NOT NULL THEN
        (SELECT o.reversal_of FROM fin_vouchers cv WHERE cv.id=o.voucher_id AND cv.status<>'void')
      ELSE (SELECT rr.reversal_of FROM fin_obligations rr JOIN fin_vouchers rrv ON rrv.id=rr.voucher_id
        WHERE o.event_id IS NOT NULL AND rr.event_id=o.event_id AND rr.reversal_of IS NOT NULL AND rr.reversal_of<>o.id
        AND rr.id<o.id AND rrv.status<>'void' ORDER BY rr.id DESC LIMIT 1) END AS prev
      FROM fin_obligations o WHERE o.kind=?) WHERE prev IS NOT NULL),
  fin_chain_walk(id,cur) AS (SELECT id,prev FROM fin_chain_link
    UNION ALL SELECT w.id,l.prev FROM fin_chain_walk w JOIN fin_chain_link l ON l.id=w.cur AND l.prev<w.cur),
  fin_chain_root(id,root) AS MATERIALIZED (SELECT id,min(cur) FROM fin_chain_walk GROUP BY id)`;

/** 往来 o 所在冲销链的链头编号；不在链上的是它自己。查询前面要带 `WITH RECURSIVE ` + chainCtes()。 */
export const chainRoot = (o: string) => `coalesce((SELECT g.root FROM fin_chain_root g WHERE g.id=${o}.id),${o}.id)`;

/** 往来 o 在某条冲销链上（链头或链里的一环）。查询前面要带 `WITH RECURSIVE ` + chainCtes()。 */
export const inChain = (o: string) =>
  `EXISTS(SELECT 1 FROM fin_chain_root g WHERE g.id=${o}.id OR g.root=${o}.id)`;
