import { ShieldCheck } from 'lucide-react';
import { FormMessage } from './Message';
import { emit } from './events';
import { useAuthState } from './auth-state';

/**
 * 改全员共用的东西（账号、AI 设置、提示词、消息接入、工具启停）要在超级管理员模式里：
 * 超级管理员账号还没进模式时，页面顶上一句提示和入口，入口打开账号菜单里同一个“系统维护”窗口。
 * 本机管理员一直算在模式里，别的账号进不了模式，都不显示。what 是要做的事，比如“新建和修改账号”。
 */
export function SuperModeNotice({ what }: { what: string }) {
  const actor = useAuthState()?.actor;
  if (!actor || actor.role !== 'super_admin' || actor.superAdminMode) return null;
  return (
    // 说明和按钮分两行：按钮不跟在句号后面，手机上折行也不会挤在句尾
    <FormMessage tone="info">
      <p>{what}要先验证本人密码，进入超级管理员模式（15 分钟内有效）。</p>
      <p className="super-mode-notice-action">
        <button type="button" className="secondary" onClick={() => emit('erp-open-maintenance')}>
          <ShieldCheck size={14} aria-hidden="true" />
          进入超级管理员模式
        </button>
      </p>
    </FormMessage>
  );
}
