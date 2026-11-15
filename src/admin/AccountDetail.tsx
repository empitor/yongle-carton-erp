import { ActionBar, DetailPanel, FormField, FormMessage, Section, StatusChip, type RecordAction } from '../ui/index';
import type { AccountView } from '../../shared/core/index';
import { levelName, levelOptions } from './account-confirms';
import type { AccountsState } from './useAccounts';

/**
 * 账号详情（右侧面板）。操作：重置密码最常用；停用是危险操作，收进“更多”；已停用的账号主操作是启用。
 * 自己的账号、没进超级管理员模式时（changing 为 false）不显示操作和级别选择。
 */
export default function AccountDetail({
  user,
  selfId,
  changing,
  accounts,
  close,
}: {
  user: AccountView;
  selfId: string;
  changing: boolean;
  accounts: AccountsState;
  close: () => void;
}) {
  const { busy, error, confirm } = accounts;
  const self = user.id === selfId;
  const enable: RecordAction = { label: '启用', disabled: busy, onClick: () => accounts.enable(user) };
  const reset: RecordAction = { label: '重置密码', disabled: busy, onClick: () => accounts.resetPassword(user) };
  const disable: RecordAction = { label: '停用', danger: true, disabled: busy, onClick: () => accounts.disable(user) };
  const actions =
    self || !changing ? undefined : user.disabled ? (
      <ActionBar primary={[enable]} secondary={[reset]} />
    ) : (
      <ActionBar secondary={[reset]} more={[disable]} />
    );
  return (
    <DetailPanel
      kicker="账号"
      title={user.name}
      status={<StatusChip tone={user.disabled ? 'warning' : 'success'}>{user.disabled ? '已停用' : '正常'}</StatusChip>}
      subtitle={levelName(user.level) + (self ? ' · 当前账号' : '')}
      close={close}
      actions={actions}
    >
      <div data-agent-private className="adm-account-detail">
        {!confirm && <FormMessage>{error}</FormMessage>}
        {changing && (
          <Section title="权限">
            <FormField
              label="级别"
              hint={self ? '选了新级别要确认才生效。自己的密码在右上角菜单里改。' : '选了新级别要确认才生效。'}
            >
              <select
                aria-label="级别"
                disabled={busy}
                value={user.level}
                onChange={(e) => accounts.changeLevel(user, e.target.value)}
              >
                {levelOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </FormField>
          </Section>
        )}
      </div>
    </DetailPanel>
  );
}
