import { Router, type ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import type { AuthManager } from '../auth.js';
import type { Store } from '../db.js';
import { financeActor, financeError } from './core.js';
import { FinanceSettings } from './settings.js';
import { FinanceLedger } from './ledger.js';
import { FinanceBooks } from './books.js';
import { FinanceEvents } from './events.js';
import { FinanceParties } from './parties.js';
import { mountFinanceRoutes } from './routes17.js';
import { financeAttachment } from './export-workbook.js';

const inputLabels: Record<string, string> = {
  period: '会计期间', date: '日期', from: '起始日期', to: '截止日期', dueDate: '到期日',
  kind: '类型', status: '状态', metric: '统计项目', sourceMonth: '单据月份', missingTax: '缺税率筛选',
  account: '科目编码', accountCode: '科目编码', accountId: '资金账户', partyId: '往来单位',
  amount: '金额', bankBalance: '银行余额', debit: '借方金额', credit: '贷方金额',
  rate: '税率', mode: '含税口径', version: '记录版本', description: '摘要', reason: '原因',
};
const financeInputError: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (!(error instanceof ZodError)) return next(error);
  const messages = error.issues.map((issue) => {
    if (/^\p{Script=Han}/u.test(issue.message)) return issue.message;
    const field = String(issue.path.at(-1) ?? '');
    const label = Object.hasOwn(inputLabels, field) ? inputLabels[field] : '填写内容或筛选条件';
    return label + '无效，请检查后重试。';
  });
  res.status(400).json({ message: [...new Set(messages)].join('；') });
};

export function financeRouter(store: Store, auth?: AuthManager) {
  const router = Router(),
    settings = new FinanceSettings(store);
  const ledger = new FinanceLedger(store),
    books = new FinanceBooks(store);
  const events = new FinanceEvents(store),
    parties = new FinanceParties(store);
  router.use((req, res, next) => {
    res.locals.financeActor = financeActor(auth?.actor(req));
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-erp-auth-token'] !== auth?.csrf)
      financeError('页面凭证已过期，请刷新。', 403);
    next();
  });
  router.get('/settings', (_req, res) => res.json(settings.get(res.locals.financeActor)));
  router.put('/settings', (req, res) =>
    res.json(settings.update(res.locals.financeActor, req.body)),
  );
  router.get('/accounts', (_req, res) => res.json(settings.accounts(res.locals.financeActor)));
  router.put('/accounts', (req, res) =>
    res.json(settings.saveAccount(res.locals.financeActor, req.body)),
  );
  router.delete('/accounts', (req, res) =>
    res.json(settings.deleteAccount(res.locals.financeActor, req.body)),
  );
  router.get('/periods', (_req, res) => res.json(settings.periods(res.locals.financeActor)));
  router.get('/opening', (_req, res) => res.json(settings.opening(res.locals.financeActor)));
  router.post('/opening/enable', (req, res) =>
    res.json(settings.enable(res.locals.financeActor, req.body)),
  );
  router.get('/vouchers', (req, res) => res.json(ledger.list(res.locals.financeActor, req.query)));
  router.post('/vouchers', (req, res) =>
    res.status(201).json(ledger.create(res.locals.financeActor, req.body)),
  );
  router.get('/vouchers/:id', (req, res) =>
    res.json(ledger.get(res.locals.financeActor, req.params.id)),
  );
  router.put('/vouchers/:id', (req, res) =>
    res.json(ledger.update(res.locals.financeActor, req.params.id, req.body)),
  );
  router.delete('/vouchers/:id', (req, res) =>
    ledger.remove(res.locals.financeActor, req.params.id),
  );
  for (const action of ['submit', 'approve', 'post', 'void'] as const)
    router.post('/vouchers/:id/' + action, (req, res) =>
      res.json(ledger.transition(res.locals.financeActor, req.params.id, action, req.body)),
    );
  router.post('/vouchers/:id/reverse', (req, res) =>
    res.json(ledger.reverse(res.locals.financeActor, req.params.id, req.body)),
  );
  router.get('/books/:kind', (req, res) =>
    res.json(books.read(res.locals.financeActor, req.params.kind, req.query)),
  );
  router.get('/books/:kind/export', async (req, res) => {
    const { title, period, bytes } = books.export(res.locals.financeActor, req.params.kind, req.query);
    financeAttachment(res, title + '-' + period, 'xlsx', await bytes);
  });
  router.get('/audit', (req, res) => res.json(books.audit(res.locals.financeActor, req.query)));
  router.post('/events/sync', (req, res) =>
    res.json(events.sync(res.locals.financeActor, req.body)),
  );
  router.get('/events', (req, res) => res.json(events.list(res.locals.financeActor, req.query)));
  router.get('/events/:id', (req, res) =>
    res.json(events.get(res.locals.financeActor, req.params.id)),
  );
  router.post('/events/:id/resolve', (req, res) =>
    res.json(events.resolve(res.locals.financeActor, req.params.id, req.body)),
  );
  router.post('/events/:id/generate', (req, res) =>
    res.json(events.generate(res.locals.financeActor, req.params.id, req.body)),
  );
  router.get('/templates', (_req, res) => res.json(events.templates(res.locals.financeActor)));
  router.put('/templates', (req, res) =>
    res.json(events.saveTemplate(res.locals.financeActor, req.body)),
  );
  router.put('/party-terms', (req, res) =>
    res.json(parties.saveTerms(res.locals.financeActor, req.body)),
  );
  router.get('/obligations', (req, res) =>
    res.json(parties.obligations(res.locals.financeActor, req.query)),
  );
  mountFinanceRoutes(router, store);
  router.use(financeInputError);
  return router;
}
