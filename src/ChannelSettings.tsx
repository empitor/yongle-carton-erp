import { useEffect, useState } from 'react';
import { managementRequest } from './session';
import type { WecomBotState, WecomBotStatus } from '../shared/inbox';

type View = { botId: string; hasSecret: boolean; enabled: boolean; status: WecomBotStatus };
export const wecomBotStateLabels: Record<WecomBotState, string> = {
  off: '未启用',
  connecting: '连接中',
  connected: '已连接',
  retrying: '连接断开，正在重试',
  auth_failed: '连接被拒绝',
  kicked: '已被其他连接顶替',
};
const toneOf = (state: WecomBotState) =>
  state === 'connected' ? 'ok' : state === 'off' ? 'muted' : state === 'connecting' ? 'busy' : 'bad';

/** 消息接入：目前只有企业微信智能机器人。Secret 只写入不回显。 */
export default function ChannelSettings() {
  const [view, setView] = useState<View | null>(null),
    [botId, setBotId] = useState(''),
    [secret, setSecret] = useState(''),
    [saving, setSaving] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const read = (first = false) =>
      managementRequest<View>('/inbox/wecom-bot')
        .then((v) => {
          if (!live) return;
          setView(v);
          // 只在打开时带入已保存的 Bot ID，之后不覆盖正在填的内容。
          if (first) setBotId(v.botId);
        })
        .catch((e) => live && setError(e.message));
    void read(true);
    const timer = setInterval(() => void read(), 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  const save = async (enabled: boolean) => {
    setSaving(true);
    setError('');
    try {
      const v = await managementRequest<View>('/inbox/wecom-bot', {
        botId: botId.trim(),
        ...(secret.trim() ? { secret: secret.trim() } : {}),
        enabled,
      });
      setView(v);
      setSecret('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const status = view?.status;
  const canConnect = !!botId.trim() && (!!secret.trim() || !!view?.hasSecret);
  return (
    <section className="panel channel-settings" aria-label="企业微信机器人">
      <header className="channel-head">
        <h2>企业微信机器人</h2>
        {status && (
          <span className="channel-state" data-tone={toneOf(status.state)}>
            {wecomBotStateLabels[status.state]}
          </span>
        )}
      </header>
      {status?.lastError && <p className="channel-error">{status.lastError}</p>}
      {error && (
        <p className="channel-error" role="alert">
          {error}
        </p>
      )}
      <form
        className="channel-form"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          void save(true);
        }}
      >
        <label className="field">
          <span>Bot ID</span>
          <input
            value={botId}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setBotId(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Secret</span>
          <input
            type="password"
            value={secret}
            spellCheck={false}
            autoComplete="new-password"
            placeholder={view?.hasSecret ? '已保存，不改就留空' : '从企业微信后台复制'}
            onChange={(e) => setSecret(e.target.value)}
          />
        </label>
        <div className="form-actions">
          <button className="primary" type="submit" disabled={saving || !canConnect}>
            {view?.enabled ? '保存并重新连接' : '保存并连接'}
          </button>
          {view?.enabled && (
            <button type="button" disabled={saving} onClick={() => void save(false)}>
              断开
            </button>
          )}
        </div>
      </form>
      {status && status.received > 0 && (
        <p className="sub">
          本次启动后收到 {status.received} 条
          {status.lastMessageAt && '，最近一条 ' + new Date(status.lastMessageAt).toLocaleString('zh-CN')}
        </p>
      )}
      <ul className="channel-notes">
        <li>企业微信后台要把这个机器人的 API 模式设为“长连接”。</li>
        <li>单聊发给机器人的文字、图片、文件都会进收件箱；群里只收 @ 机器人的文字。</li>
        <li>收到后机器人会回一句确认；文件超过 20MB 不保存，也会回复告知。</li>
        <li>同一个机器人只能连一处，别的地方连上后这里会断开，不会自动抢回。</li>
      </ul>
    </section>
  );
}
