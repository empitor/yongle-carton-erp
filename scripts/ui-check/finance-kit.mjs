// 财务流程共用：财务窗口的填写帮手、调财务接口、把待记账凭证一次走完（走接口），
// 和各组开头用接口准备的前置数据。只走公开接口，和页面上的按钮发同样的请求。
import { mkdirSync } from 'node:fs';
import { SP, businessDay, call, fail } from './lib.mjs';

export const today = businessDay();
export const period = today.slice(0, 7);
export const shotsDir = SP + '/finance-shots';
mkdirSync(shotsDir, { recursive: true });

/** 本月启用财务、建一个资金账户（有了账户才能开收付款单） */
async function openBooksVia({ fin, must }) {
  const settings = await must('读财务设置', fin('GET', '/settings'));
  await must('启用财务', fin('POST', '/opening/enable', { period, taxpayer: 'general', version: settings.version, rows: [] }));
  await must('建资金账户', fin('PUT', '/cash/accounts', { name: '虚构基本户', kind: 'bank', accountCode: '1002' }));
}

/**
 * 财务各组的起点（和 basics + ledger 点出来的状态一样）：启用财务、建资金账户、关审核分离、
 * 本月待补税率的单据按 13% 未税补上、生成凭证并记账。
 */
async function prepareBooksVia(books) {
  const { fin, must, sync, postAll } = books;
  await openBooksVia(books);
  await sync();
  const enabled = await fin('GET', '/settings');
  await must('关审核分离', fin('PUT', '/settings', { version: enabled.version, requireSeparateApprover: false }));
  const missing = ((await fin('GET', `/monthly-ledger?period=${period}&missingTax=1&pageSize=200`)).rows || []).filter(
    (r) => Number(r.missing_tax) && r.id,
  );
  const items = [];
  for (const r of missing) items.push({ id: r.id, version: (await fin('GET', '/events/' + r.id)).version });
  if (items.length) await must('补税率', fin('POST', '/tax-completion/batch', { items, rate: '13', mode: '未税' }));
  for (const e of (await fin('GET', '/events?status=ready&pageSize=200')).rows || [])
    if (!e.voucher_id) await must('生成凭证', fin('POST', '/events/' + e.id + '/generate', { version: e.version }));
  await postAll();
}
/** 收某个客户一笔款，全额核销它余额最大的那张应收（ledger 第 D 节点出来的那种），再记账 */
async function prepareReceiptVia({ fin, must, postAll }, partyName) {
  const ob = ((await fin('GET', '/obligations?kind=receivable&pageSize=200')).rows || [])
    .filter((o) => String(o.party_name).includes(partyName) && Number(o.balance) > 0)
    .sort((a, b) => Number(b.balance) - Number(a.balance))[0];
  if (!ob) throw new Error(partyName + ' 没有未收的应收');
  const account = ((await fin('GET', '/cash/accounts?pageSize=50')).rows || [])[0];
  const doc = await must(
    '建收款',
    fin('PUT', '/cash/documents', {
      kind: 'receipt',
      date: today,
      method: '银行',
      accountId: Number(account.id),
      partyId: Number(ob.party_id),
      amount: Number(ob.balance),
      description: '虚构收款',
    }),
  );
  const allocations = [{ obligationId: Number(ob.id), version: Number(ob.version), amount: Number(ob.balance), discount: 0 }];
  await must('确认收款并核销', fin('POST', '/cash/documents/' + doc.id + '/confirm', { version: doc.version, allocations }));
  await postAll();
}

export function financeKit(page) {
  const dlg = () => page.locator('[role="dialog"][aria-modal="true"]').last();
  const modals = () => page.locator('[role="dialog"][aria-modal="true"]').count();
  const field = (label) => dlg().locator('label.field', { hasText: label }).first();
  const text = (label, v) => field(label).locator('input,textarea').first().fill(String(v));
  const pick = (label, v) => field(label).locator('select').first().selectOption(v);
  /** 可搜索的下拉：填字后选第一项；v 为空就选第一项 */
  const combo = async (label, v) => {
    const i = field(label).locator('input').first();
    await i.click();
    if (v) await i.fill(v);
    await page.waitForTimeout(200);
    await i.press('ArrowDown');
    await i.press('Enter');
    await page.waitForTimeout(200);
  };
  /** 等弹窗关掉（最多 timeout 毫秒），代替固定等待 */
  const closed = async (before, timeout = 3000) => {
    for (let waited = 0; waited < timeout && (await modals()) >= before; waited += 100) await page.waitForTimeout(100);
    await page.waitForTimeout(250);
  };
  /** 点窗口里的按钮保存；窗口没关就把报错记成问题（run.mjs 认“dialog error”）并取消 */
  const save = async (label = '保存') => {
    const before = await modals();
    await dlg().getByRole('button', { name: label, exact: true }).click();
    await closed(before);
    const open = await modals();
    if (open) {
      console.log('  dialog error:', label, (await dlg().locator('.form-message.tone-danger').allInnerTexts()).join('|').slice(0, 300));
      await dlg().getByRole('button', { name: '取消', exact: true }).click();
    }
    return !open;
  };
  /** 直接写账的动作都先弹确认窗：点确认窗里的主按钮 */
  const confirmDialog = async () => {
    await dlg().locator('button.primary, button.danger-solid').last().waitFor();
    const before = await modals();
    await dlg().locator('button.primary, button.danger-solid').last().click();
    await closed(before, 5000);
  };
  /**
   * 财务接口；写入带 requestId（和页面一样：页面读走 fin-api.ts 的 finRead、useFinRead，
   * 写在各页签 *-api.ts 用 call<FinanceWrites>() 发、交 finWritten），出错返回 { error }
   */
  const fin = (method, path, body) =>
    call(page, method, '/finance' + path, method === 'GET' ? undefined : { requestId: crypto.randomUUID(), ...body });
  const must = async (what, promise) => {
    const value = await promise;
    if (value?.error) throw new Error(what + '失败：' + value.error);
    return value;
  };
  /**
   * 本月待记账的凭证都提交、审核、记账，和凭证页“提交本页 / 审核本页 / 记账本页”发同样的请求。
   * 点按钮那一遍只在 flow-ledger 里走，别处给后面准备数据用这个。
   */
  const postAll = async () => {
    for (const [status, step] of [['draft', 'submit'], ['pending', 'approve'], ['approved', 'post']]) {
      const rows = (await fin('GET', `/vouchers?period=${period}&status=${status}&pageSize=200`)).rows || [];
      for (const r of rows) {
        const done = await fin('POST', `/vouchers/${r.id}/${step}`, { version: r.version });
        if (done.error) fail('凭证 ' + (r.number || r.id) + ' ' + step + ' 失败：' + done.error);
      }
    }
    await refresh();
  };
  /** 接口改了数据页面不知道：发一次“业务数据变了”，财务页面的列表和详情重新读取 */
  const refresh = () => page.evaluate(() => window.dispatchEvent(new Event('erp-business-changed')));
  /**
   * 服务端在每个财务请求前补扫业务单据（一次最多两批）：接口造了单据，读几次资料检查，
   * 读到没有还没进财务的为止（unsynced 截至本月底）
   */
  const sync = async () => {
    for (let i = 0; i < 20; i++)
      if (!(await must('读资料检查', fin('GET', `/reports/readiness?period=${period}`))).unsynced) return;
  };
  const books = { fin, must, sync, postAll };
  const openBooks = () => openBooksVia(books);
  const prepareBooks = () => prepareBooksVia(books);
  const prepareReceipt = (partyName) => prepareReceiptVia(books, partyName);
  /** 结账页“业务单据”没处理完时点“去处理”：要落到业务单据页的“全部”，要处理的单据列得出来（closing 是结账检查） */
  const checkEventsLink = async (closing) => {
    if (!closing.steps.some((s) => s.key === 'events' && !s.ok))
      return fail('结账检查的“业务单据”一步已经放行，没测到“去处理”的落点');
    await page.locator('.fb-steps li', { hasText: '业务单据都已生成凭证或处理完' }).getByRole('link', { name: '去处理' }).click();
    await page.locator('.fin-table tbody tr.record-row').first().waitFor({ timeout: 5000 }).catch(() => {});
    const status = await page.getByLabel('单据状态').inputValue();
    const listed = await page.locator('.fin-table tbody tr.record-row').count();
    if (status !== '' || !listed) fail('结账页“去处理”落到业务单据页时筛选是“' + status + '”、列了 ' + listed + ' 条');
    else console.log('结账页去处理落到全部 ok', listed);
  };
  return {
    dlg, modals, field, text, pick, combo, closed, save, confirmDialog, fin, must, postAll, refresh, sync,
    openBooks, prepareBooks, prepareReceipt, checkEventsLink,
  };
}
