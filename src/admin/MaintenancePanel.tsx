import { useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { authChanged, type AuthState, beijingTime } from '../ui/index';
import { errorMessage } from '../../shared/core/index';
import { changeSuperMode } from './account-api';
import { EditorFooter, FormField, FormMessage, ManagementDialog } from '../ui/index';
import { StatusChip } from '../ui/index';

/** 超级管理员模式能做什么：这个窗口和页面顶上的横幅说同一句 */
const superModeScope =
  '可以做平时会被拦下的维护操作，比如管理账号，修改 AI 设置、提示词、消息接入和助手工具启停，查看和修改已归档的记录，删除已核对的单据和档案，撤销生产任务、完工和采购退货，批准超出订单数量的发货；删已核对的单据和档案时，每次仍要核对会一起处理的记录，并输本人密码确认。';
const validUntil = (until: unknown) => '有效至' + beijingTime(until, 'clock') + '。';

/** 页面顶上的横幅：从域名访问的超级管理员进了模式时显示（本机管理员一直在模式里，不显示） */
export function SuperModeBanner({ until }: { until: unknown }) {
  return (
    <div className="super-mode-banner" role="status">
      <ShieldCheck size={19} />
      <div>
        <strong>超级管理员模式已开启</strong>
        <span>{superModeScope + validUntil(until)}</span>
      </div>
    </div>
  );
}

/**
 * 账号菜单里的“系统维护”窗口：只有超级管理员模式这一件事（不在服务器本机的管理员用；
 * 本机最高管理员的账号菜单直接是“数据管理”，不进这个窗口）。
 * 一个窗口只办一件事：一句说明、（没开启时）一个密码框，底栏“取消”和这一步的主按钮，办完就关。
 */
export default function MaintenancePanel({
  session,
  busy,
  setBusy,
  close,
}: {
  session: AuthState;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  close: () => void;
}) {
  const [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    input = useRef<HTMLInputElement>(null);
  const actor = session.actor;
  // 账号菜单只在登录以后出现，没登录打不开这个窗口
  if (!actor) return null;
  const superMode = !!actor.superAdminMode;
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await changeSuperMode(!superMode, password);
      authChanged();
      close();
    } catch (failure) {
      setError(errorMessage(failure));
      // 输错了清空重输，光标放回密码框
      setTimeout(() => input.current?.focus(), 0);
    } finally {
      setPassword('');
      setBusy(false);
    }
  };
  return (
    <ManagementDialog
      title="系统维护"
      size="sm"
      close={close}
      busy={busy}
      footer={
        <EditorFooter>
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            取消
          </button>
          <button
            type="submit"
            form="super-mode-form"
            className={superMode ? 'secondary' : 'primary'}
            disabled={busy || (!superMode && !password)}
          >
            {busy
              ? superMode
                ? '正在退出…'
                : '正在验证…'
              : superMode
                ? '退出超级管理员模式'
                : '进入超级管理员模式'}
          </button>
        </EditorFooter>
      }
    >
      <FormMessage>{error}</FormMessage>
      <section className="adm-maint">
        <header>
          <h3>
            <ShieldCheck size={16} aria-hidden="true" /> 超级管理员模式
          </h3>
          <StatusChip tone={superMode ? 'warning' : 'neutral'}>
            {superMode ? '已开启' : '未开启'}
          </StatusChip>
        </header>
        <p>
          {superMode
            ? superModeScope + validUntil(actor.superAdminUntil)
            : '输入本人密码，临时开启 15 分钟。' + superModeScope}
        </p>
        <form
          id="super-mode-form"
          className="adm-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {!superMode && (
            <FormField label="本人密码">
              {/* 不标 required：空着时主按钮本来就点不了；标了的话，输错密码清空后
                  必填引导会把它当成“提交了没填”，在密码不对之外再冒一条“标红的必填项还没填” */}
              <input
                ref={input}
                type="password"
                maxLength={128}
                autoComplete="current-password"
                aria-label="本人密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </FormField>
          )}
        </form>
      </section>
    </ManagementDialog>
  );
}
