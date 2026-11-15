import { useState, type SubmitEvent } from 'react';
import { useAction } from './ui/index';

/** 登录页的几个视图：选账号、登录、申请账号、忘记密码，和两个“已提交” */
export type LoginView = 'accounts' | 'login' | 'apply' | 'forgot' | 'applied' | 'forgot-sent';

/** 登录页各视图共用的填写内容、提交和切换视图（切换时清掉出错提示和密码）。 */
export function useLoginForm(initial: LoginView) {
  const [view, setView] = useState<LoginView>(initial),
    [name, setName] = useState(''),
    [password, setPassword] = useState(''),
    [repeat, setRepeat] = useState(''),
    [note, setNote] = useState('');
  const { busy, error, run, clear } = useAction();
  const go = (next: LoginView) => {
    setView(next);
    clear();
    setPassword('');
    setRepeat('');
  };
  /** 表单提交：办 job，失败时原因写在表单里 */
  const submit = (job: () => Promise<void>) => (e: SubmitEvent) => {
    e.preventDefault();
    void run(job);
  };
  return { view, go, name, setName, password, setPassword, repeat, setRepeat, note, setNote, busy, error, submit };
}
export type LoginForm = ReturnType<typeof useLoginForm>;
