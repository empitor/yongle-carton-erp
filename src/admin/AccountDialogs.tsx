import { useState } from 'react';
import { Copy } from 'lucide-react';
import { ManagementDialog } from '../ui/index';
import { beijingTime, useAction } from '../ui/index';
import { PasswordField } from '../ui/index';
import { EditorFooter, FormField, FormMessage, FormSection } from '../ui/index';
import { Facts } from '../ui/index';
import type { AccountLevel, AccountRequestView } from '../../shared/core/index';
import { approveRequest, createAccount, type AccountResult } from './account-api';
import { knownLevel, levelOptions } from './account-confirms';

/** 选的级别：还没选是空 */
type ChosenLevel = AccountLevel | '';
/** 提交时一定选了级别（下拉标了必选，浏览器不让空着提交）；空着就说清楚、不发 */
function chosenLevel(level: ChosenLevel): AccountLevel {
  if (!level) throw new Error('请选择级别。');
  return level;
}

/** 级别下拉，外面用 FormField 包标签。 */
function LevelSelect({ value, change }: { value: ChosenLevel; change: (value: ChosenLevel) => void }) {
  return (
    <select required value={value} onChange={(e) => change(knownLevel(e.currentTarget.value) ?? '')}>
      <option value="" disabled>
        请选择
      </option>
      {levelOptions.map(([key, label]) => (
        <option key={key} value={key}>
          {label}
        </option>
      ))}
    </select>
  );
}

/** 临时密码只显示这一次：大字显示，可以复制。 */
export function TemporaryPassword({
  name,
  password,
  close,
}: {
  name: string;
  password: string;
  close: () => void;
}) {
  const [copied, setCopied] = useState('');
  return (
    <ManagementDialog
      title="已生成临时密码"
      subtitle={'给 ' + name}
      size="sm"
      close={close}
      footer={
        <EditorFooter note="24 小时内有效，对方登录后必须先改掉。">
          <button className="primary" onClick={close}>
            完成
          </button>
        </EditorFooter>
      }
    >
      <div className="adm-temp" data-agent-private>
        <p className="confirm-text">把这个密码告诉 {name}。关掉窗口后就看不到了。</p>
        <div className="adm-temp-row">
          <code className="temp-password">{password}</code>
          <button
            type="button"
            className="secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(password);
                setCopied('已复制');
              } catch {
                setCopied('浏览器不允许复制，请手动选中');
              }
            }}
          >
            <Copy size={14} aria-hidden="true" />
            复制
          </button>
        </div>
        {copied && (
          <p className="adm-inline-status" role="status">
            {copied}
          </p>
        )}
      </div>
    </ManagementDialog>
  );
}

/** 通过账号申请：先看申请信息，再定用户名和级别。 */
export function ApproveDialog({
  request,
  close,
  done,
}: {
  request: AccountRequestView;
  close: () => void;
  done: (result: AccountResult, name: string) => void;
}) {
  const [name, setName] = useState(request.name),
    [level, setLevel] = useState<ChosenLevel>(''),
    { busy, error, run } = useAction();
  return (
    <ManagementDialog
      title="通过账号申请"
      subtitle={'申请人 ' + request.name}
      size="sm"
      close={close}
      busy={busy}
      footer={
        <EditorFooter>
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            取消
          </button>
          <button type="submit" form="adm-approve-form" className="primary" disabled={busy}>
            {busy ? '正在处理…' : '通过'}
          </button>
        </EditorFooter>
      }
    >
      <FormMessage>{error}</FormMessage>
      <FormMessage tone="warning">任何人都能填别人的名字，请先线下确认申请人是谁。</FormMessage>
      <div className="adm-dialog-facts">
        <Facts
          items={[
            { label: '提交时间', value: beijingTime(request.createdAt, 'short') },
            { label: '来源', value: request.client },
            { label: '说明', value: request.note, wide: true },
          ]}
        />
      </div>
      <form
        id="adm-approve-form"
        className="adm-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => done(await approveRequest(request.id, { name, level: chosenLevel(level) }), name));
        }}
      >
        <FormSection title="开通账号">
          <FormField
            label="用户名"
            required
            error={request.nameTaken && name === request.name ? '这个用户名已经有人用了，请改一个。' : undefined}
          >
            <input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <FormField label="级别" required>
            <LevelSelect value={level} change={setLevel} />
          </FormField>
        </FormSection>
      </form>
    </ManagementDialog>
  );
}

/** 管理员直接新建账号。 */
export function CreateDialog({
  close,
  done,
}: {
  close: () => void;
  done: (result: AccountResult, name: string) => void;
}) {
  const [name, setName] = useState(''),
    [password, setPassword] = useState(''),
    [level, setLevel] = useState<ChosenLevel>(''),
    { busy, error, run } = useAction();
  return (
    <ManagementDialog
      title="新建账号"
      size="sm"
      close={close}
      busy={busy}
      footer={
        <EditorFooter note="对方用初始密码登录后可以自己改。">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            取消
          </button>
          <button type="submit" form="adm-create-form" className="primary" disabled={busy}>
            {busy ? '正在新建…' : '新建账号'}
          </button>
        </EditorFooter>
      }
    >
      <FormMessage>{error}</FormMessage>
      <form
        id="adm-create-form"
        className="adm-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => done(await createAccount({ name, password, level: chosenLevel(level) }), name));
        }}
      >
        <FormSection columns={1}>
          <FormField label="用户名" required>
            <input
              required
              autoFocus
              maxLength={60}
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </FormField>
          <PasswordField
            label="初始密码"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            rule
          />
          <FormField label="级别" required>
            <LevelSelect value={level} change={setLevel} />
          </FormField>
        </FormSection>
      </form>
    </ManagementDialog>
  );
}
