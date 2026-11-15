import { useState } from 'react';
import { useConfirm, notify, stepper, useAction } from '../../ui/index';
import { today } from '../../../shared/core/index';
import { ErrorLine, FinSection, PeriodInput, type HeadFn } from '../layout';
import { FinList, col, mon, type Col } from '../table';
import { exportHref, useFinPerms, useFinRead, type FinData } from '../fin-api';
import { Status } from '../status';
import { usePeriod } from '../page-state';
import { FormDialog } from '../FormDialog';
import AssetPanel from './AssetPanel';
import { assetBody, assetFields, assetSections } from './asset-forms';
import {
  accrualNotice,
  closingJobs,
  depreciate as runDepreciation,
  jobDone,
  listAssets,
  listDepreciation,
  saveAsset,
  type AssetRow,
} from './costs-api';

/** 一个月的折旧明细一行 */
type DepreciationRow = FinData<'GET /finance/depreciation'>['rows'][number];

const assetCols: Col<AssetRow>[] = [
  col('number', '编号'),
  col('name', '名称', { wrap: true }),
  col('category', '类别'),
  // 1280 宽打开详情时区域约 600px，8 列约 630px：先收部门、使用月数，详情里都有
  col('department', '部门', { priority: 'mid' }),
  col('date', '入账日期'),
  col('months', '使用月数', { num: true, priority: 'mid' }),
  mon('original_cents', '原值 / 元'),
  col('status', '状态', { render: (r) => <Status value={r.status} /> }),
];
const depreciationCols: Col<DepreciationRow>[] = [
  col('number', '编号'),
  col('name', '名称', { wrap: true }),
  col('department', '部门'),
  mon('amount_cents', '折旧 / 元'),
];

/**
 * 固定资产：平均年限法，次月开始折旧；在详情里调部门或科目、处置。
 * 页头主按钮按状态：有在用资产、这个月还没计提时是“计提折旧”（先确认），否则是“新建固定资产”。
 */
export default function AssetsTab({ head }: { head: HeadFn }) {
  const perms = useFinPerms();
  const [period, setPeriod] = usePeriod();
  const [dialog, setDialog] = useState(false);
  const [row, setRow] = useState<AssetRow | null>(null);
  const [rows, setRows] = useState<AssetRow[]>([]);
  const [depreciated, setDepreciated] = useState<boolean | null>(null);
  const action = useAction();
  const [confirmDialog, confirm] = useConfirm();
  const depreciate = async () => {
    if (
      !(await confirm({
        title: '计提 ' + period + ' 折旧',
        message: '按平均年限法算这个月所有在用资产的折旧，生成一张待记账凭证。记账前可以作废重来。',
        confirmLabel: '计提折旧',
      }))
    )
      return;
    await action.run(async () => {
      notify(accrualNotice(period + ' 计提折旧', await runDepreciation(period)));
    });
  };
  const inUse = rows.some((r) => r.status !== 'disposed');
  // 这个月计提过没有：有折旧明细，或结账检查里折旧这一步已完成（新买的资产当月没折旧，明细是空的）
  const closing = useFinRead(closingJobs(period));
  const depreciationDone = jobDone(closing.data, 'depreciation');
  const depAction =
    perms.close && inUse
      ? {
          label: '计提折旧',
          disabled: action.busy,
          onClick: () => void depreciate(),
        }
      : null;
  const newAction = perms.edit ? { label: '新建固定资产', onClick: () => setDialog(true) } : null;
  const needsDepreciation = !!depAction && depreciated === false && !depreciationDone;
  return (
    <>
      {head({
        children: <PeriodInput value={period} onChange={setPeriod} />,
        primary: needsDepreciation ? depAction : newAction,
        more: [
          needsDepreciation ? newAction : depAction,
          {
            label: '导出 ' + period + ' 折旧',
            href: exportHref('/depreciation/export', { period }),
            download: true,
          },
        ],
      })}
      <ErrorLine text={action.error} close={action.clear} />
      <FinList
        list={listAssets}
        query={{}}
        label="固定资产"
        onData={(d) => setRows(d.rows)}
        onRow={setRow}
        selected={row?.id}
        empty={perms.edit ? '还没有固定资产，点页面上方的“新建固定资产”' : '还没有固定资产'}
        cols={assetCols}
      />
      <FinSection title={period + ' 折旧明细'}>
        <FinList
          list={listDepreciation}
          label="折旧明细"
          query={{ period }}
          rowKey={(r) => r.asset_id}
          onData={(d) => setDepreciated(d.rows.length > 0)}
          empty={inUse ? '这个月还没计提折旧' : '这个月没有折旧'}
          cols={depreciationCols}
        />
      </FinSection>
      {row && (
        <AssetPanel
          key={row.id}
          row={row}
          close={() => setRow(null)}
          {...stepper(rows, (r) => r.id, row.id, setRow)}
        />
      )}
      {dialog && (
        <FormDialog
          title="新建固定资产"
          size="md"
          sections={assetSections}
          note="平均年限法，次月开始折旧。保存后生成待记账的入账凭证。"
          fields={assetFields}
          initial={{
            date: today(),
            residual: '0',
            cashFlow: '购建固定资产支付的现金',
          }}
          submitLabel="保存资产"
          notice="固定资产已登记，入账凭证待记账。"
          close={() => setDialog(false)}
          submit={(v) => saveAsset(assetBody(v))}
        />
      )}
      {confirmDialog}
    </>
  );
}
