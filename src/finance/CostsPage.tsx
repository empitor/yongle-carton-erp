import { useRef, useState } from 'react';
import DetailPanel from '../ui/DetailPanel';
import ManagementDialog from '../ManagementDialog';
import { PageHeading } from '../ui/ListLayout';
import {
  ErrorLine,
  ExportLink,
  Facts,
  FinList,
  FormDialog,
  PeriodInput,
  Status,
  Tabs,
  col,
  finSend,
  finUpload,
  mon,
  toCents,
  todayText,
  useAction,
  useFin,
  useFinPerms,
  usePeriod,
  useTab,
  yuan,
} from './kit';

const tabs = [
  ['expenses', '费用报销'],
  ['assets', '固定资产'],
  ['payroll', '工资'],
  ['costing', '库存成本'],
  ['margin', '毛利'],
] as const;

function ExpensesTab() {
  const perms = useFinPerms();
  const [row, setRow] = useState<any>(null);
  const [dialog, setDialog] = useState<'edit' | 'new' | 'pay' | 'reject' | 'advance' | null>(null);
  const action = useAction();
  const move = (act: 'submit' | 'approve') =>
    action.run(async () => {
      await finSend('POST', '/expenses/' + row.id + '/transition', {
        action: act,
        version: row.version,
        ...(act === 'approve' ? { date: todayText() } : {}),
      });
      setRow(null);
    });
  const fields = [
    { name: 'employeeId', label: '员工工号', required: true },
    { name: 'employeeName', label: '员工姓名', required: true },
    { name: 'department', label: '部门', required: true },
    { name: 'date', label: '日期', type: 'date' as const, required: true },
    { name: 'accountCode', label: '费用科目', type: 'account' as const, required: true },
    { name: 'amount', label: '金额 / 元', type: 'money' as const, required: true },
    { name: 'description', label: '说明', required: true, wide: true },
  ];
  return (
    <>
      <div className="fin-toolbar">
        <span className="fin-grow" />
        {perms.cash && <button onClick={() => setDialog('advance')}>员工借还款</button>}
        {perms.edit && (
          <button className="primary" onClick={() => setDialog('new')}>
            新建费用单
          </button>
        )}
      </div>
      <ErrorLine text={action.error} close={action.clear} />
      <FinList
        path="/expenses"
        label="费用单"
        onRow={setRow}
        selected={row?.id}
        empty="还没有费用单"
        cols={[
          col('date', '日期'),
          col('employee_name', '员工'),
          col('department', '部门'),
          col('description', '说明', { wrap: true }),
          col('status', '状态', { render: (r) => <Status value={r.status} /> }),
          mon('amount_cents', '金额 / 元'),
        ]}
      />
      {row && (
        <DetailPanel
          title={row.employee_name + ' · ' + row.date}
          status={<Status value={row.status} />}
          close={() => setRow(null)}
          actions={
            <div className="fin-actions">
              {['draft', 'rejected'].includes(row.status) && perms.edit && (
                <>
                  <button className="primary" disabled={action.busy} onClick={() => move('submit')}>
                    提交审批
                  </button>
                  <button onClick={() => setDialog('edit')}>修改</button>
                </>
              )}
              {row.status === 'pending' && perms.approve && (
                <>
                  <button className="primary" disabled={action.busy} onClick={() => move('approve')}>
                    批准
                  </button>
                  <button onClick={() => setDialog('reject')}>退回</button>
                </>
              )}
              {row.status === 'approved' && perms.cash && (
                <button className="primary" onClick={() => setDialog('pay')}>
                  付款
                </button>
              )}
            </div>
          }
        >
          <Facts
            items={[
              ['部门', row.department],
              ['科目', row.account_code],
              ['金额 / 元', yuan(row.amount_cents)],
              ['说明', row.description],
            ]}
          />
        </DetailPanel>
      )}
      {(dialog === 'new' || dialog === 'edit') && (
        <FormDialog
          title={dialog === 'new' ? '新建费用单' : '修改费用单'}
          fields={fields}
          initial={
            dialog === 'edit'
              ? {
                  employeeId: row.employee_id,
                  employeeName: row.employee_name,
                  department: row.department,
                  date: row.date,
                  accountCode: row.account_code,
                  amount: row.amount_cents,
                  description: row.description,
                }
              : { date: todayText() }
          }
          close={() => setDialog(null)}
          submit={async (v) => {
            await finSend('PUT', '/expenses', {
              ...v,
              ...(dialog === 'edit' ? { id: row.id, version: row.version } : {}),
            });
            setRow(null);
          }}
        />
      )}
      {dialog === 'pay' && row && (
        <FormDialog
          title="付款"
          fields={[
            { name: 'date', label: '付款日期', type: 'date', required: true },
            { name: 'accountId', label: '资金账户', type: 'cash-account', required: true },
          ]}
          initial={{ date: todayText() }}
          close={() => setDialog(null)}
          submit={async (v) => {
            await finSend('POST', '/expenses/' + row.id + '/transition', {
              ...v,
              action: 'pay',
              version: row.version,
            });
            setRow(null);
          }}
        />
      )}
      {dialog === 'reject' && row && (
        <FormDialog
          title="退回费用单"
          fields={[{ name: 'reason', label: '原因', required: true, wide: true }]}
          close={() => setDialog(null)}
          submit={async (v) => {
            await finSend('POST', '/expenses/' + row.id + '/transition', {
              ...v,
              action: 'reject',
              version: row.version,
            });
            setRow(null);
          }}
        />
      )}
      {dialog === 'advance' && (
        <FormDialog
          title="员工借还款"
          fields={[
            {
              name: 'kind',
              label: '类型',
              type: 'select',
              required: true,
              options: [
                ['loan', '借款'],
                ['repayment', '还款'],
              ],
            },
            { name: 'employeeId', label: '员工工号', required: true },
            { name: 'employeeName', label: '员工姓名', required: true },
            { name: 'date', label: '日期', type: 'date', required: true },
            { name: 'accountId', label: '资金账户', type: 'cash-account', required: true },
            { name: 'accountCode', label: '其他应收科目', type: 'account', required: true },
            { name: 'amount', label: '金额 / 元', type: 'money', required: true },
            { name: 'description', label: '说明', required: true, wide: true },
          ]}
          initial={{ kind: 'loan', date: todayText(), accountCode: '1221' }}
          close={() => setDialog(null)}
          submit={(v) => finSend('POST', '/employee-advances', v)}
        />
      )}
    </>
  );
}

function AssetsTab() {
  const perms = useFinPerms();
  const [period, setPeriod] = usePeriod();
  const [dialog, setDialog] = useState<'new' | 'change' | 'dispose' | null>(null);
  const [row, setRow] = useState<any>(null);
  const action = useAction();
  return (
    <>
      <div className="fin-toolbar">
        <PeriodInput value={period} onChange={setPeriod} />
        <span className="fin-grow" />
        <ExportLink path="/depreciation/export" query={{ period }} label="导出折旧" />
        {perms.close && (
          <button
            disabled={action.busy}
            onClick={() => action.run(() => finSend('POST', '/depreciation', { period }))}
          >
            计提 {period} 折旧
          </button>
        )}
        {perms.edit && (
          <button className="primary" onClick={() => setDialog('new')}>
            新增资产
          </button>
        )}
      </div>
      <ErrorLine text={action.error} close={action.clear} />
      <FinList
        path="/assets"
        label="固定资产"
        onRow={setRow}
        selected={row?.id}
        empty="还没有固定资产"
        cols={[
          col('number', '编号'),
          col('name', '名称', { wrap: true }),
          col('category', '类别'),
          col('department', '部门'),
          col('date', '入账日期'),
          col('months', '使用月数', { num: true }),
          mon('original_cents', '原值 / 元'),
          col('status', '状态', { render: (r) => <Status value={r.status} /> }),
        ]}
      />
      <h2 className="fin-note">{period} 折旧明细</h2>
      <FinList
        path="/depreciation"
        label="折旧明细"
        query={{ period }}
        rowKey={(r) => r.asset_id}
        empty="这个月还没有折旧"
        cols={[
          col('number', '编号'),
          col('name', '名称', { wrap: true }),
          col('department', '部门'),
          mon('amount_cents', '折旧 / 元'),
        ]}
      />
      {row && (
        <DetailPanel
          title={row.name}
          status={<Status value={row.status} />}
          close={() => setRow(null)}
          actions={
            perms.edit && row.status !== 'disposed' ? (
              <div className="fin-actions">
                <button onClick={() => setDialog('change')}>调部门或科目</button>
                <button onClick={() => setDialog('dispose')}>处置</button>
              </div>
            ) : undefined
          }
        >
          <Facts
            items={[
              ['编号', row.number],
              ['类别', row.category],
              ['部门', row.department],
              ['费用科目', row.expense_account],
              ['原值 / 元', yuan(row.original_cents)],
              ['残值率', row.residual_bp / 100 + '%'],
              ['使用月数', row.months],
              ['入账日期', row.date],
            ]}
          />
        </DetailPanel>
      )}
      {dialog === 'new' && (
        <FormDialog
          title="新增固定资产"
          intro="平均年限法，次月开始折旧。"
          fields={[
            { name: 'number', label: '编号', required: true },
            { name: 'name', label: '名称', required: true },
            { name: 'category', label: '类别', required: true },
            { name: 'department', label: '部门', required: true },
            { name: 'date', label: '入账日期', type: 'date', required: true },
            { name: 'original', label: '原值 / 元', type: 'money', required: true },
            { name: 'months', label: '使用月数', type: 'int', required: true },
            { name: 'residualBp', label: '残值率（万分比）', type: 'int', required: true, hint: '5% 填 500' },
            { name: 'expenseAccount', label: '折旧费用科目', type: 'account', required: true },
            { name: 'counterAccount', label: '付款科目', type: 'account', required: true },
            { name: 'cashFlow', label: '现金流量项目', type: 'cash-flow', required: true },
          ]}
          initial={{ date: todayText(), residualBp: 0, cashFlow: '购建固定资产支付的现金' }}
          close={() => setDialog(null)}
          submit={(v) => finSend('POST', '/assets', v)}
        />
      )}
      {dialog === 'change' && row && (
        <FormDialog
          title="调部门或科目"
          fields={[
            { name: 'date', label: '生效日期', type: 'date', required: true },
            { name: 'department', label: '部门', required: true },
            { name: 'expenseAccount', label: '折旧费用科目', type: 'account', required: true },
            { name: 'reason', label: '原因', required: true, wide: true },
          ]}
          initial={{ date: todayText(), department: row.department, expenseAccount: row.expense_account }}
          close={() => setDialog(null)}
          submit={async (v) => {
            await finSend('PUT', '/assets/' + row.id, { ...v, version: row.version });
            setRow(null);
          }}
        />
      )}
      {dialog === 'dispose' && row && (
        <FormDialog
          title="处置固定资产"
          danger
          fields={[
            { name: 'date', label: '日期', type: 'date', required: true },
            { name: 'proceeds', label: '处置收入 / 元', type: 'money' },
            { name: 'accountId', label: '资金账户', type: 'cash-account' },
            { name: 'reason', label: '原因', required: true, wide: true },
          ]}
          initial={{ date: todayText() }}
          close={() => setDialog(null)}
          submit={async (v) => {
            await finSend('POST', '/assets/' + row.id + '/dispose', { ...v, version: row.version });
            setRow(null);
          }}
        />
      )}
    </>
  );
}

function PayrollTab() {
  const perms = useFinPerms();
  const [period, setPeriod] = usePeriod();
  const [detail, setDetail] = useState(false);
  const [dialog, setDialog] = useState<'upload' | 'pay' | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const action = useAction();
  return (
    <>
      <div className="fin-toolbar">
        <PeriodInput value={period} onChange={setPeriod} />
        {perms.close && (
          <label className="fin-check">
            <input type="checkbox" checked={detail} onChange={(e) => setDetail(e.target.checked)} />
            看员工明细
          </label>
        )}
        <span className="fin-grow" />
        {perms.close && <button onClick={() => setDialog('upload')}>导入工资表</button>}
        {perms.close && (
          <button
            disabled={action.busy}
            onClick={() => action.run(() => finSend('POST', '/payroll/confirm', { period }))}
          >
            计提
          </button>
        )}
        {perms.cash && <button onClick={() => setDialog('pay')}>发放</button>}
      </div>
      <p className="fin-note">
        只导入算好的工资汇总，系统不算个税和社保。工资进正式报表，不进理论盈亏。没有工资的月份，结账前点一下“计提”即可。
      </p>
      <ErrorLine text={action.error} close={action.clear} />
      <FinList
        path="/payroll"
        label="工资"
        query={{ period, detail: detail ? 1 : 0 }}
        rowKey={(r, i) => r.id ?? r.department ?? i}
        empty="这个月没有工资数据"
        cols={[
          ...(detail
            ? [col('employee_name', '员工')]
            : [col('employees', '人数', { num: true })]),
          col('department', '部门'),
          mon('gross', '应发'),
          mon('social', '个人社保'),
          mon('housing', '个人公积金'),
          mon('tax', '个税'),
          mon('net', '实发'),
          mon('employer_social', '单位社保'),
          mon('employer_housing', '单位公积金'),
        ]}
      />
      {dialog === 'upload' && (
        <FormDialog
          title={'导入 ' + period + ' 工资表'}
          intro="表头后按顺序：工号、姓名、部门、科目、应发、个人社保、个人公积金、个税、实发、单位社保、单位公积金。"
          submitLabel="导入"
          fields={[]}
          close={() => setDialog(null)}
          submit={async () => {
            const file = fileRef.current?.files?.[0];
            if (!file) throw new Error('请选择文件。');
            await finUpload(
              '/payroll/upload',
              { period, format: /\.csv$/i.test(file.name) ? 'csv' : 'xlsx' },
              file,
            );
          }}
        >
          <label className="field">
            <span>文件 *</span>
            <input ref={fileRef} type="file" accept=".csv,.xlsx" />
          </label>
        </FormDialog>
      )}
      {dialog === 'pay' && (
        <FormDialog
          title={'发放 ' + period + ' 工资'}
          fields={[
            { name: 'date', label: '发放日期', type: 'date', required: true },
            { name: 'accountId', label: '资金账户', type: 'cash-account', required: true },
          ]}
          initial={{ date: todayText() }}
          close={() => setDialog(null)}
          submit={(v) => finSend('POST', '/payroll/pay', { ...v, period })}
        />
      )}
    </>
  );
}

/** 算成本前把系统算不出来的填上：启用月已有库存的期初成本、手工出入库的金额。 */
function CostingDialog({ period, close }: { period: string; close: () => void }) {
  const { data, error } = useFin('/costing/requirements', { period });
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [counters, setCounters] = useState<Record<string, string>>({});
  const accounts = useFin<any[]>('/accounts');
  const action = useAction();
  const opening: any[] = data?.opening || [];
  const valuations: any[] = data?.valuations || [];
  const needed = valuations.filter((v) => v.needsAmount || v.needsCounter);
  const submit = () =>
    action.run(async () => {
      await finSend('POST', '/costing', {
        period,
        opening: opening.map((o) => {
          const text = amounts['s' + o.stockId];
          if (!text?.trim()) throw new Error('请填写期初成本：' + o.name);
          return { stockId: o.stockId, unit: o.unit, quantity: o.quantity, amount: toCents(text) };
        }),
        valuations: needed.map((v) => {
          const text = amounts[v.id];
          if (v.needsAmount && !text?.trim()) throw new Error('请填写入库金额：' + v.name);
          if (v.needsCounter && !counters[v.id]) throw new Error('请选择对方科目：' + v.name);
          return {
            movementId: v.id,
            unit: v.unit,
            amount: v.needsAmount ? toCents(text) : 0,
            ...(counters[v.id] ? { counterAccount: counters[v.id] } : {}),
            reason: '月末成本录入',
          };
        }),
      });
      close();
    });
  return (
    <ManagementDialog title={'计算 ' + period + ' 成本'} busy={action.busy} close={close}>
      <div className="fin-form fin-wide">
        <ErrorLine text={error} />
        {!data ? (
          <p className="fin-note">正在读取…</p>
        ) : (
          <>
            <p className="form-intro">
              月末加权平均。到货和完工的金额系统自己算，下面列的是算不出来、要你填的。填 0 表示没有成本。
              {opening.length > 0 &&
                ' 这里的金额要和启用财务时填的原材料（1403）、库存商品（1405）期初一致，否则这两个科目的余额会对不上。'}
              {!opening.length && !needed.length && ' 这个月没有要填的，直接计算。'}
            </p>
            {opening.length > 0 && (
              <div className="fin-subform">
                <h3>启用前已有的库存，期初值多少钱</h3>
                <div className="table-wrap">
                  <table className="fin-lines">
                    <thead>
                      <tr>
                        <th>库存品</th>
                        <th className="num">数量</th>
                        <th>单位</th>
                        <th>金额 / 元</th>
                      </tr>
                    </thead>
                    <tbody>
                      {opening.map((o) => (
                        <tr key={o.stockId}>
                          <td>{o.name}</td>
                          <td className="num">{o.quantity / 1000}</td>
                          <td>{o.unit}</td>
                          <td>
                            <input
                              aria-label={o.name + ' 期初金额'}
                              inputMode="decimal"
                              value={amounts['s' + o.stockId] ?? ''}
                              onChange={(e) =>
                                setAmounts({ ...amounts, ['s' + o.stockId]: e.target.value })
                              }
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {needed.length > 0 && (
              <div className="fin-subform">
                <h3>手工出入库</h3>
                <div className="table-wrap">
                  <table className="fin-lines">
                    <thead>
                      <tr>
                        <th>日期</th>
                        <th>库存品</th>
                        <th className="num">数量</th>
                        <th>单位</th>
                        <th>备注</th>
                        <th>入库金额 / 元</th>
                        <th>对方科目</th>
                      </tr>
                    </thead>
                    <tbody>
                      {needed.map((v) => (
                        <tr key={v.id}>
                          <td>{v.date}</td>
                          <td>{v.name}</td>
                          <td className="num">{v.quantity / 1000}</td>
                          <td>{v.unit}</td>
                          <td>{v.notes || '—'}</td>
                          <td>
                            {v.needsAmount ? (
                              <input
                                aria-label={v.name + ' 入库金额'}
                                inputMode="decimal"
                                value={amounts[v.id] ?? ''}
                                onChange={(e) => setAmounts({ ...amounts, [v.id]: e.target.value })}
                              />
                            ) : (
                              '按平均价'
                            )}
                          </td>
                          <td>
                            {v.needsCounter ? (
                              <select
                                aria-label={v.name + ' 对方科目'}
                                value={counters[v.id] ?? ''}
                                onChange={(e) => setCounters({ ...counters, [v.id]: e.target.value })}
                              >
                                <option value="">请选择</option>
                                {(accounts.data || [])
                                  .filter((a) => a.leaf && a.enabled)
                                  .map((a) => (
                                    <option key={a.code} value={a.code}>
                                      {a.code} {a.name}
                                    </option>
                                  ))}
                              </select>
                            ) : (
                              '默认'
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
        <ErrorLine text={action.error} close={action.clear} />
        <div className="management-dialog-actions">
          <button type="button" onClick={close} disabled={action.busy}>
            取消
          </button>
          <button className="primary" disabled={action.busy || !data} onClick={submit}>
            计算
          </button>
        </div>
      </div>
    </ManagementDialog>
  );
}

function CostingTab() {
  const perms = useFinPerms();
  const [period, setPeriod] = usePeriod();
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="fin-toolbar">
        <PeriodInput value={period} onChange={setPeriod} />
        <span className="fin-grow" />
        {perms.close && (
          <button className="primary" onClick={() => setOpen(true)}>
            计算 {period} 成本
          </button>
        )}
      </div>
      <p className="fin-note">月末加权平均。数量单位各算各的，不换算。</p>
      {open && <CostingDialog period={period} close={() => setOpen(false)} />}
      <FinList
        path="/costing"
        label="库存成本"
        query={{ period }}
        rowKey={(r) => r.stock_id}
        empty="这个月还没有算成本"
        cols={[
          col('stock_name', '库存品', { wrap: true }),
          col('unit', '单位'),
          col('opening_qty', '期初数量', { num: true, render: (r) => r.opening_qty / 1000 }),
          mon('opening_cents', '期初金额'),
          col('in_qty', '入库数量', { num: true, render: (r) => r.in_qty / 1000 }),
          mon('in_cents', '入库金额'),
          col('out_qty', '出库数量', { num: true, render: (r) => r.out_qty / 1000 }),
          mon('out_cents', '出库金额'),
          col('end_qty', '期末数量', { num: true, render: (r) => r.end_qty / 1000 }),
          mon('end_cents', '期末金额'),
        ]}
      />
    </>
  );
}

function MarginTab() {
  const [period, setPeriod] = usePeriod();
  const [group, setGroup] = useState('order');
  return (
    <>
      <div className="fin-toolbar">
        <PeriodInput value={period} onChange={setPeriod} />
        <select aria-label="毛利维度" value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="order">按订单</option>
          <option value="customer">按客户</option>
          <option value="product">按产品</option>
          <option value="month">按月</option>
        </select>
      </div>
      <p className="fin-note">要先算当月成本。这是会计口径的毛利，和理论盈亏是两回事。</p>
      <FinList
        path="/margin"
        label="毛利"
        query={{ period, group }}
        rowKey={(r, i) => r.group_id ?? i}
        empty="这个月没有毛利数据"
        cols={[
          col('group_id', { order: '订单', customer: '客户', product: '产品', month: '月份' }[group] || '分组', {
            render: (r) => r.group_id ?? '未分配',
          }),
          mon('revenue', '收入'),
          mon('cost', '成本'),
          mon('margin', '毛利'),
        ]}
      />
    </>
  );
}

export default function CostsPage() {
  const [tab, setTab] = useTab('expenses');
  return (
    <div className="fin-page">
      <PageHeading title="费用资产工资" />
      <Tabs label="费用资产工资分类" tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'expenses' && <ExpensesTab />}
      {tab === 'assets' && <AssetsTab />}
      {tab === 'payroll' && <PayrollTab />}
      {tab === 'costing' && <CostingTab />}
      {tab === 'margin' && <MarginTab />}
    </div>
  );
}
