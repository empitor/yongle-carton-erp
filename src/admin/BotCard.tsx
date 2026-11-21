import { useState } from 'react';
import { FormMessage, beijingTime, useAction } from '../ui/index';
import { saveBot } from './settings-api';
import {
  INBOX_MAX_FILE_TEXT,
  botCredentialLabels,
  botStateLabels,
  type BotChannel,
  type BotState,
  type BotView,
} from '../../shared/import/index';

const toneOf = (state: BotState) =>
  state === 'connected' ? 'ok' : state === 'off' ? 'muted' : state === 'connecting' ? 'busy' : 'bad';

/** 三家都一样的：单聊收什么、回执、大小上限。 */
const receiveNote =
  '单聊发给机器人的文字、图片、文件都会进收件箱；收到后机器人会回一句确认，文件超过 ' +
  INBOX_MAX_FILE_TEXT +
  ' 不保存，也会回复告知。';
const randomSplit = (name: string) => '同一个应用不要在两处同时连：' + name + '会把消息随机发给其中一处。';
/** 各家自己的：后台怎么设、群里收什么、同一个应用连两处会怎样。 */
const notes: Record<BotChannel, { setup: string; group: string; sameApp: string }> = {
  wecom_bot: {
    setup: '企业微信后台要把这个机器人的 API 模式设为“长连接”。',
    group: '群里只收 @ 机器人的文字。',
    sameApp: '同一个机器人只能连一处，别的地方连上后这里会断开，不会自动抢回。',
  },
  feishu_bot: {
    setup:
      '飞书开发者后台：企业自建应用开启机器人能力，事件订阅选“使用长连接接收事件”，添加“接收消息”事件；要先在这里连上，飞书后台才能保存长连接的订阅方式。',
    group: '后台只开 @ 机器人的群消息权限时，群里只收 @ 的消息。',
    sameApp: randomSplit('飞书'),
  },
  dingtalk_bot: {
    setup: '钉钉开发者后台：企业内部应用添加机器人能力，消息接收模式选“Stream 模式”，并开通企业内机器人发送消息权限。',
    group: '群里只收 @ 机器人的文字和图片。',
    sameApp: randomSplit('钉钉'),
  },
};

/**
 * 一家机器人：填凭据、保存并连接、断开，显示连接状态。Secret 只写入不回显。
 * changing 为 false（超级管理员账号没进超级管理员模式）时只看状态，不出填写框和按钮。
 */
export default function BotCard({
  view,
  onSaved,
  changing,
}: {
  view: BotView;
  onSaved: (views: BotView[]) => void;
  changing: boolean;
}) {
  const labels = botCredentialLabels[view.channel],
    note = notes[view.channel];
  const [appId, setAppId] = useState(view.appId),
    [secret, setSecret] = useState(''),
    { busy: saving, error, run } = useAction();
  const save = (enabled: boolean) =>
    run(async () => {
      onSaved(await saveBot(view.channel, { appId: appId.trim(), ...(secret.trim() ? { secret: secret.trim() } : {}), enabled }));
      setSecret('');
    });
  const { status } = view;
  const canConnect = !!appId.trim() && (!!secret.trim() || view.hasSecret);
  return (
    <section className="panel channel-settings" aria-label={view.label}>
      <header className="channel-head">
        <h2>{view.label}</h2>
        <span className="channel-state" data-tone={toneOf(status.state)}>
          {botStateLabels[status.state]}
        </span>
      </header>
      {/* 没启用时状态标签已经写了“未启用”，不再用红字重复一遍 */}
      {status.state !== 'off' && <FormMessage>{status.lastError}</FormMessage>}
      <FormMessage>{error}</FormMessage>
      {changing && (
        <form
          className="channel-form"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            void save(true);
          }}
        >
          <label className="field">
            <span>{labels.appId}</span>
            <input value={appId} spellCheck={false} autoComplete="off" onChange={(e) => setAppId(e.target.value)} />
          </label>
          <label className="field">
            <span>{labels.secret}</span>
            <input
              type="password"
              value={secret}
              spellCheck={false}
              autoComplete="new-password"
              placeholder={view.hasSecret ? '已保存，不改就留空' : '从后台复制'}
              onChange={(e) => setSecret(e.target.value)}
            />
          </label>
          <div className="form-actions">
            <button className="primary" type="submit" disabled={saving || !canConnect}>
              {view.enabled ? '保存并重新连接' : '保存并连接'}
            </button>
            {view.enabled && (
              <button type="button" disabled={saving} onClick={() => void save(false)}>
                断开
              </button>
            )}
          </div>
        </form>
      )}
      {status.received > 0 && (
        <p className="sub">
          本次启动后收到 {status.received} 条
          {status.lastMessageAt && '，最近一条 ' + beijingTime(status.lastMessageAt)}
        </p>
      )}
      <ul className="channel-notes">
        {[note.setup, receiveNote, note.group, note.sameApp].map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
    </section>
  );
}
