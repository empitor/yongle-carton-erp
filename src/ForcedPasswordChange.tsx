import { useState } from 'react';
import ChangePasswordForm from './ChangePasswordForm';
import { LoginAlert, LoginCard } from './LoginCard';
import { errorMessage } from '../shared/core/index';
import { signOut } from './auth-api';

/** 用临时密码登录后停在这里，改完才能进系统。服务端同样拒绝这种会话访问业务接口。 */
export default function ForcedPasswordChange({ name }: { name: string }) {
  const [error, setError] = useState('');
  return (
    <LoginCard title="先改密码" subtitle={name + '，你现在用的是临时密码，改完才能进入系统'}>
      <ChangePasswordForm currentLabel="临时密码" submitLabel="保存并进入系统" onDone={() => location.reload()} />
      <LoginAlert text={error} />
      <button
        type="button"
        className="login-link login-link-center"
        onClick={() => signOut().catch((failure: unknown) => setError(errorMessage(failure)))}
      >
        退出登录
      </button>
    </LoginCard>
  );
}
