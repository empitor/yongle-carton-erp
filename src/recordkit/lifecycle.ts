/**
 * 归档、恢复办完以后怎么说：档案（客户、产品、订单、供应商、采购单、库存品，record-api.ts 的 requestLifecycle）
 * 和单据（生产任务、完工、到货、送货，flow/flow-api.ts 的 archiveFlows）同一套说法。
 */

export type LifecycleAction = 'archive' | 'restore';
type Result = { id: number; success: boolean; message?: string };

/**
 * 几条服务端原因连成一句：服务端的原因自带句号（“……先出库或盘点清零，再归档。”），每条先去掉末尾的句号、分号再用“；”连，
 * 整句一个句号收尾，不出现“。；”“。。”。几条带着同一句后半句（服务端按账号补的“要删的话……”）时，
 * 后半句只在最后说一次。都是空的返回空串。
 */
export function joinReasons(reasons: string[]) {
  const parts = reasons.map((r) => String(r ?? '').trim().replace(/[。；;.，,\s]+$/u, '')).filter(Boolean),
    tails = parts.map((p) => (p.includes('；') ? p.slice(p.lastIndexOf('；') + 1) : '')),
    shared = tails.find((t, i) => t && tails.indexOf(t) !== i),
    body = shared ? parts.map((p, i) => (tails[i] === shared ? p.slice(0, -shared.length - 1) : p)) : parts;
  return body.length ? [...body, ...(shared ? [shared] : [])].join('；') + '。' : '';
}

/**
 * 办完以后怎么说：全办成给页面提示一句（只有一条时说它的名字，归档的说去“已归档”里能找到）；
 * 有没办成的只说一次——全没办成不写“已归档 0 张”、用危险色，办成一部分先说办成几条、用提醒色。
 */
export function lifecycleOutcome(
  action: LifecycleAction,
  results: Result[],
  nameOf: (id: number) => string,
  unit: string,
) {
  const failed = results.filter((r) => !r.success),
    done = results.filter((r) => r.success),
    verb = action === 'archive' ? '归档' : '恢复';
  if (!failed.length)
    return {
      failed,
      notice:
        '已' + verb + ' ' + (done.length === 1 ? nameOf(done[0].id) : done.length + ' ' + unit) +
        (action === 'archive' ? '，在列表的“已归档”里能找到和恢复。' : '。'),
      problem: '',
      tone: 'danger' as const,
    };
  const problem =
    failed.length === 1 && !done.length
      ? nameOf(failed[0].id) + ' 没能' + verb + '：' + joinReasons([failed[0].message || ''])
      : (done.length ? '已' + verb + ' ' + done.length + ' ' + unit + '；' : '') +
        failed.length + ' ' + unit + '没能' + verb + '。' +
        joinReasons(failed.map((r) => nameOf(r.id) + '：' + r.message));
  return { failed, notice: '', problem, tone: done.length ? ('warning' as const) : ('danger' as const) };
}
