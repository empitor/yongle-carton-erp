// 样式比对要走的页面和状态（style-compare.mjs 用）。只打开、点开、再关掉，不保存任何东西；
// 唯一的写入是准备阶段在隔离实例里启用财务（虚构数据，每次都是全新实例）。
// 每个状态：{ id, hash, act?(page, h), modes? }。act 抛错就记成“造不出来”，接着跑下一个。

const dialog = (page) => page.locator('[role="dialog"][aria-modal="true"]').last();
/** 点一下：先正常点；被别的东西挡住、或者元素一直在动（右下角的小人）点不上，再强制点 */
async function press(locator) {
  try {
    await locator.click({ timeout: 3000 });
  } catch {
    await locator.click({ timeout: 3000, force: true });
  }
}

const visible = (locator) => locator.filter({ visible: true }).first();

/** 点开列表第一行（排产板点第一张卡片），等右侧详情出来 */
async function openFirstRow(page) {
  const row = visible(page.locator('main tbody tr, main .board-card'));
  await row.waitFor({ timeout: 5000 });
  await press(row);
  await page.locator('.detail-panel').first().waitFor({ timeout: 5000 });
  // 手机上详情是滑进来的，等停稳再点里面的按钮，不然点“更多”时页面滚动的距离每次不一样
  await page.waitForTimeout(600);
}
/** 详情里的“更多”菜单 */
async function openMore(page) {
  await openFirstRow(page);
  const more = visible(
    page.locator('.detail-panel summary, .detail-panel button').filter({ hasText: '更多' }),
  );
  await more.waitFor({ timeout: 3000 });
  await press(more);
  // 页头也可能有一个收着的“更多”，只等看得见的菜单项
  await visible(page.locator('[role="menuitem"]')).waitFor({ timeout: 3000 });
}
/** 详情里的“编辑”：有按钮点按钮，没有就到“更多”里找 */
async function openEdit(page) {
  await openFirstRow(page);
  const button = visible(
    page.locator('.detail-panel').getByRole('button', { name: '编辑', exact: true }),
  );
  if (await button.count()) await press(button);
  else {
    await openMore(page);
    await press(visible(page.getByRole('menuitem', { name: /^(编辑|修改)/ })));
  }
  await dialog(page).waitFor({ timeout: 5000 });
}
/** 页头的主按钮（新建、登记一类） */
async function openPrimary(page) {
  await press(
    page.locator('main .page-actions button.primary, main .page-heading button.primary').first(),
  );
  await dialog(page).waitFor({ timeout: 5000 });
}

const pages = [
  ['首页', '#'],
  ['业务概览', '#dashboard'],
  ['订单', '#orders'],
  ['客户', '#customers'],
  ['产品', '#products'],
  ['使用说明', '#guide'],
  ['收件箱', '#inbox'],
  ['AI导入', '#ai-import'],
  ['AI设置', '#ai-settings'],
  ['AI设置-单据模板', '#ai-settings?tab=templates'],
  ['AI设置-工具', '#ai-settings?tab=tools'],
  ['提示词', '#ai-prompts'],
  ['插件', '#ai-plugins'],
  ['单据模板', '#document-templates'],
  ['账号', '#accounts'],
  ['回收站', '#trash'],
  ['供应商', '#suppliers'],
  ['采购', '#purchases'],
  ['原材料库存', '#warehouse?kind=raw'],
  ['成品库存', '#warehouse?kind=finished'],
  ['到货', '#warehouse?arrivals=1'],
  ['送货', '#warehouse?kind=finished&deliveries=1'],
  ['库存流水', '#warehouse?flow=1'],
  ['到货页', '#warehouse?arrivals=1'],
  ['生产任务', '#production'],
  ['完工记录', '#production?view=production'],
  ['财务概览', '#finance'],
  ['财务台账', '#finance-flow'],
  ['财务台账-缺税率', '#finance-flow?missing=1'],
  ['应收应付', '#finance-ar'],
  ['应收应付-将到期', '#finance-ar?tab=soon'],
  ['资金', '#finance-cash'],
  ['成本', '#finance-costs'],
  ['账簿', '#finance-ledger'],
  ['账簿-业务事件', '#finance-ledger?tab=events'],
  ['账簿-凭证', '#finance-ledger?tab=vouchers'],
  ['账簿-明细账', '#finance-ledger?tab=books'],
  ['报表', '#finance-reports'],
  ['报表-期间', '#finance-reports?tab=periods'],
  ['财务设置', '#finance-settings'],
];

// 有详情的列表：详情、更多菜单、编辑窗。第一条记录的详情里没有“更多”或“编辑”的标 false
// （按 0.8.4 时的页面试出来的；页面改了以后能点了，把 false 去掉就会跟着截）
const lists = [
  ['订单', '#orders'],
  ['客户', '#customers'],
  ['产品', '#products', { edit: false }],
  ['供应商', '#suppliers'],
  ['采购', '#purchases'],
  ['原材料库存', '#warehouse?kind=raw'],
  ['成品库存', '#warehouse?kind=finished'],
  ['到货', '#warehouse?arrivals=1', { edit: false }],
  ['送货', '#warehouse?kind=finished&deliveries=1', { edit: false }],
  ['库存流水', '#warehouse?flow=1', { more: false, edit: false }],
  ['生产任务', '#production', { edit: false }],
  ['完工记录', '#production?view=production', { edit: false }],
  ['收件箱', '#inbox', { edit: false }],
  ['账号', '#accounts', { edit: false }],
  ['财务台账', '#finance-flow', { more: false, edit: false }],
];

// 页头主按钮打开的窗口
const creates = [
  ['订单', '#orders'],
  ['客户', '#customers'],
  ['产品', '#products'],
  ['供应商', '#suppliers'],
  ['采购', '#purchases'],
  ['送货', '#warehouse?kind=finished&deliveries=1'],
  ['生产任务', '#production'],
  ['账号', '#accounts'],
  ['资金', '#finance-cash'],
  ['账簿-凭证', '#finance-ledger?tab=vouchers'],
];

/** 页头“更多”里的新建（库存没有主按钮，新建库存品收在“更多”里） */
const fromHeadingMore = (name) => async (page) => {
  await press(
    visible(
      page
        .locator('main .page-actions summary, main .page-actions button')
        .filter({ hasText: '更多' }),
    ),
  );
  await press(visible(page.getByRole('menuitem', { name })));
  await dialog(page).waitFor({ timeout: 5000 });
};

export const scenes = [
  ...pages.map(([id, hash]) => ({ id: '页面-' + id, hash })),
  ...lists.flatMap(([id, hash, has = {}]) => [
    { id: '详情-' + id, hash, act: openFirstRow },
    ...(has.more === false ? [] : [{ id: '更多菜单-' + id, hash, act: openMore }]),
    ...(has.edit === false ? [] : [{ id: '编辑窗-' + id, hash, act: openEdit }]),
  ]),
  ...creates.map(([id, hash]) => ({ id: '新建窗-' + id, hash, act: openPrimary })),
  { id: '新建窗-原材料库存', hash: '#warehouse?kind=raw', act: fromHeadingMore(/新建/) },
  { id: '新建窗-成品库存', hash: '#warehouse?kind=finished', act: fromHeadingMore(/新建/) },
  {
    id: '全局-账号菜单',
    hash: '#orders',
    act: async (page) => {
      await press(page.locator('.oi-account'));
      await page.locator('.account-menu').waitFor({ timeout: 3000 });
    },
  },
  {
    id: '全局-数据管理',
    hash: '#orders',
    act: async (page) => {
      await press(page.locator('.oi-account'));
      await page.locator('.account-menu').waitFor({ timeout: 5000 });
      const item = visible(page.getByRole('menuitem', { name: '数据管理' }));
      await item.waitFor({ timeout: 8000 });
      await press(item);
      await dialog(page).waitFor({ timeout: 10000 });
      await page.waitForTimeout(800);
    },
  },
  {
    id: '全局-搜索面板',
    hash: '#orders',
    modes: ['desktop-light', 'desktop-dark'],
    act: async (page) => {
      await press(page.locator('.top-search'));
      await page.locator('[role="dialog"]').last().waitFor({ timeout: 3000 });
    },
  },
  {
    id: '全局-助手面板',
    hash: '#orders',
    act: async (page) => {
      // 小人一直在动、手机上又可能收在边上，点它不稳；发顶栏按钮用的同一个打开事件（src/ui/events.ts 的 emit）
      await page.evaluate(() => window.dispatchEvent(new Event('erp-open-assistant')));
      await page.locator('.ga-panel').waitFor({ timeout: 5000 });
    },
  },
  {
    id: '全局-筛选弹层',
    hash: '#orders',
    act: async (page) => {
      await press(page.locator('.filter-popover-toggle').first());
      await page.waitForTimeout(300);
    },
  },
  {
    id: '全局-勾选条',
    hash: '#orders',
    // 手机上列表是卡片，没有勾选框
    modes: ['desktop-light', 'desktop-dark'],
    act: async (page) => {
      const box = page.locator('main tbody tr input[type="checkbox"]').first();
      await box.waitFor({ state: 'attached', timeout: 5000 });
      await press(box);
      await page.waitForTimeout(300);
    },
  },
];

/** 准备阶段（只在电脑浅色里截）：未启用财务的样子、启用窗，然后启用财务，后面各模式都看启用后的页面 */
export const setupScenes = [
  { id: '准备-财务概览-未启用', hash: '#finance' },
  { id: '准备-财务设置-未启用', hash: '#finance-settings' },
  {
    id: '准备-启用财务窗',
    hash: '#finance-settings',
    act: async (page) => {
      await press(page.getByRole('button', { name: '启用财务' }).first());
      await dialog(page).waitFor({ timeout: 5000 });
      const select = dialog(page)
        .locator('label.field', { hasText: '纳税人身份' })
        .locator('select')
        .first();
      if (await select.count()) await select.selectOption('general');
    },
  },
];
export async function enableFinance(page) {
  await press(dialog(page).getByRole('button', { name: '确认启用', exact: true }));
  await page.waitForTimeout(1500);
}

/** 页面上一直在变、比不了的地方：截图时盖住，算样式时跳过（要加的话写在这里） */
export const ignoreSelectors = [];
/** 只在截图时藏起来、样式照比的：右下角的小甬小勒（眼睛跟着鼠标、姿势随时间变，像素每次不一样） */
export const screenshotMask = ['.ga-launcher'];
