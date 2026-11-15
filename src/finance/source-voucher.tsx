import type { ReactNode } from 'react';
import { useState } from 'react';
import type { RecordAction } from '../ui/index';
import { today } from '../../shared/core/index';
import { useFinPerms, useFinRead, type FinData } from './fin-api';
import { sendSourceVoucher } from './ledger/ledger-api';
import { FormDialog } from './FormDialog';
import { sourceVoucherActions } from './labels';

type Kind = keyof typeof sourceVoucherActions;

/** 这张凭证现在能做什么：没记账的撤回，已记账的红字冲销；已作废、本身是红字的、已被红冲的都不能 */
function actionOf({ header, reversedBy }: FinData<'GET /finance/vouchers/:id'>): Kind | null {
  if (header.status === 'void' || header.reversal_of || reversedBy) return null;
  return header.status === 'posted' ? 'reverse' : 'withdraw';
}

/**
 * 来源页面（票据、资产处置、费用报销、坏账、压款利息、保证金）的详情里给的“撤回 / 红字冲销”：
 * 读这张凭证现在的状态，没记账给撤回，已记账给红字冲销；已作废、已被红冲的不给。
 * 返回放进 ActionBar 的动作和要渲染的窗口；服务端拦下的原因（比如已有退回、已付款）照原样显示。
 * what：同一个详情里有几张凭证时写明是哪一张（例如“收票”“背书转让”“坏账”），按钮写成“撤回收票”。
 */
export function useSourceVoucher(
  voucherId: unknown,
  done?: () => void,
  what?: string,
): { action: RecordAction | null; dialog: ReactNode } {
  const perms = useFinPerms();
  const id = Number(voucherId) || null;
  const { data } = useFinRead(id ? ['GET /finance/vouchers/:id', { params: { id } }] : null);
  const [open, setOpen] = useState(false);
  const kind = data ? actionOf(data) : null;
  if (!data || !kind || !id || !(perms.edit || perms.cash)) return { action: null, dialog: null };
  const { header } = data;
  const words = sourceVoucherActions[kind];
  return {
    action: {
      label: words.label + (what ?? ''),
      danger: true,
      onClick: () => setOpen(true),
    },
    dialog: open && (
      <FormDialog
        title={words.title}
        subtitle={(what ? what + ' · ' : '') + header.period + ' 第 ' + header.number + ' 号'}
        size="sm"
        columns={1}
        danger
        intro={words.intro}
        submitLabel={words.label}
        fields={[
          ...(kind === 'reverse'
            ? [
                {
                  name: 'date',
                  label: '红冲日期',
                  type: 'date' as const,
                  required: true,
                },
              ]
            : []),
          { name: 'reason', label: '原因', type: 'textarea', required: true },
        ]}
        initial={{ date: today() }}
        notice={words.notice}
        close={() => setOpen(false)}
        submit={async (v) => {
          await sendSourceVoucher({ id, version: header.version }, kind, v);
          done?.();
        }}
      />
    ),
  };
}

/** 列表里每一行一个“撤回 / 红字冲销”按钮（例如保证金的每笔退回、转抵），和详情里的是同一个动作 */
export function SourceVoucherButton({
  voucherId,
  done,
  what,
}: {
  voucherId: unknown;
  done?: () => void;
  what?: string;
}) {
  const { action, dialog } = useSourceVoucher(voucherId, done, what);
  if (!action) return null;
  return (
    <>
      <button type="button" className="danger-text" onClick={action.onClick}>
        {action.label}
      </button>
      {dialog}
    </>
  );
}
