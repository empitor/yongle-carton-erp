// 浏览器验收专用：独立临时业务/登录/工作区，模拟模型，无生产数据或收费API。
import { createOrderWorkflowFixture } from './assistant-workflow-fixture.js';
import { AuthManager } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { customerSchema, productSchema, orderSchema, today } from '../shared/domain.js';
import { join } from 'node:path';
process.env.PORT = '3185';
const f = createOrderWorkflowFixture(),
  auth = new AuthManager(join(f.dir, 'users.sqlite'), Date.now, { localAdministration: true });
const c = f.store.saveCustomer(customerSchema.parse({ name: '虚构页面客户' })),
  p = f.store.saveProduct(productSchema.parse({ name: '虚构页面纸箱' }));
f.store.saveOrder(
  orderSchema.parse({
    customerId: c.id,
    orderDate: today(),
    deliveryDate: today(),
    status: '草稿',
    lines: [{ productId: p.id, quantity: 10, unitPriceCents: 200 }],
  }),
);
f.settings.completeOrderJson = async (messages: any) => {
  if (JSON.stringify(messages).includes('fixture-private-credential-marker-2026'))
    throw new Error('私密字段不得进入模型请求');
  const us = messages.filter((m: any) => m.role === 'user'),
    last = us.at(-1)?.content || '';
  const context = us.findLast(
    (m: any) => typeof m.content === 'string' && m.content.startsWith('服务器当前上下文'),
  );
  const idx = messages.indexOf(context),
    text = messages[idx - 1]?.content || '';
  const tool =
    typeof last === 'string' && last.startsWith('服务器工具结果')
      ? JSON.parse(last.slice(last.indexOf('{')))
      : null;
  const call = (name: string, args: any) => ({
    message: '依据实际页面执行验收操作',
    toolCalls: [{ name, args }],
  });
  if (tool) {
    if (tool.tool === 'page.observe' && tool.result.snapshot) {
      const s = tool.result.snapshot;
      const find = (match: (c: any) => boolean) => {
        const e = s.controls.find(match);
        if (!e) throw Error('验收未找到控件：' + text);
        return e.id;
      };
      if (text === '页面引用失效验收')
        return {
          message: '核验旧引用保护',
          toolCalls: [
            {
              name: 'page.act',
              args: {
                action: 'fill',
                snapshotId: s.snapshotId,
                target: find((c) => c.role === 'input'),
                value: '虚构快照变动',
              },
            },
            {
              name: 'page.act',
              args: {
                action: 'click',
                snapshotId: s.snapshotId,
                target: find((c) => c.name === '供应商管理'),
              },
            },
          ],
        };
      if (text === '页面填写订单备注')
        return call('page.act', {
          action: 'fill',
          snapshotId: s.snapshotId,
          target: find((c) => c.role === 'textarea' && c.name === '订单备注'),
          value: '虚构逐步核验',
        });
      if (text === '页面提交订单备注')
        return call('page.act', {
          action: 'submit',
          snapshotId: s.snapshotId,
          target: find((c) => c.role === 'form'),
          outcome: { module: 'orders', id: s.record.id, expected: { notes: '虚构逐步核验' } },
        });
      if (text === '页面新建客户')
        return call('page.act', {
          action: 'click',
          snapshotId: s.snapshotId,
          target: find((c) => c.name === '新增客户'),
        });
      if (text === '页面填写客户')
        return call('page.act', {
          action: 'fill',
          snapshotId: s.snapshotId,
          target: find((c) => c.role === 'input' && c.name.includes('客户名称')),
          value: '虚构Agent页面创建',
        });
      if (text === '页面保存客户')
        return call('page.act', {
          action: 'submit',
          snapshotId: s.snapshotId,
          target: find((c) => c.role === 'form'),
        });
      if (text === '页面选择状态')
        return call('page.act', {
          action: 'select',
          snapshotId: s.snapshotId,
          target: find(
            (c) => c.role === 'select' && c.options?.some((o: any) => o.value === '已发货'),
          ),
          value: '已发货',
        });
      if (text === '页面关闭弹窗')
        return call('page.act', {
          action: 'key',
          snapshotId: s.snapshotId,
          target: find((c) => c.role === 'input'),
          key: 'Escape',
        });
      if (text === '页面滚动')
        return call('page.act', { action: 'scroll', snapshotId: s.snapshotId, deltaY: 500 });
      if (text === '页面打开客户管理')
        return call('page.act', {
          action: 'click',
          snapshotId: s.snapshotId,
          target: find((c) => c.name === '客户管理'),
        });
    }
    if (text === '核验页面步骤' && tool.tool === 'task.get')
      return call('page.verify', {
        stepIds: tool.result.steps
          .filter((s: any) => s.tool === 'page.act' && s.pageOutcome && s.state === 'waiting')
          .map((s: any) => s.id),
      });
    return {
      message:
        tool.result?.ok === false
          ? tool.result.message
          : '已得到实际页面反馈，业务结果以原服务核验为准。',
      toolCalls: [],
    };
  }
  if (text === '修改当前订单交期') {
    const input = JSON.parse(context.content.slice(context.content.indexOf('{'))),
      id = input.context?.record?.id || input.page?.record?.id;
    return call('records.propose_save', {
      module: 'orders',
      id,
      patch: { deliveryDate: '2027-01-03' },
    });
  }
  if (text === '核验页面步骤') return call('task.get', {});
  return call(
    'page.observe',
    text === '页面打开客户管理'
      ? { mode: 'region', region: 'navigation' }
      : ['观察完整页面', '页面引用失效验收'].includes(text)
        ? { mode: 'full' }
        : text === '观察表格分页'
          ? { mode: 'region', region: 'table', offset: 40, limit: 5 }
          : ['观察当前记录', '页面填写订单备注', '页面提交订单备注'].includes(text)
            ? { mode: 'record' }
            : text === '观察概要增量'
              ? { mode: 'summary', diff: true }
              : {},
  );
};
const app = createApp(f.store, {
  auth,
  assistant: f.manager,
  imports: f.imports,
  aiSettings: f.settings,
  enableReviewedImports: true,
  importArchiveDirectory: join(f.dir, 'archive'),
});
const server = app.listen(3185, '127.0.0.1', () =>
  console.log('隔离浏览器实例 http://127.0.0.1:3185'),
);
process.on('SIGINT', () =>
  server.close(() => {
    auth.close();
    f.close();
    process.exit(0);
  }),
);
