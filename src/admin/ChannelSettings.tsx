import { useEffect, useState } from 'react';
import { SuperModeNotice, useAuthState } from '../ui/index';
import type { BotView } from '../../shared/import/index';
import { errorMessage } from '../../shared/core/index';
import BotCard from './BotCard';
import { readBots } from './settings-api';

/** 消息接入：各家机器人一张卡片，可以同时开；每 3 秒刷新连接状态。 */
export default function ChannelSettings() {
  const [views, setViews] = useState<BotView[] | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const read = () =>
      readBots()
        .then((v) => {
          if (!live) return;
          setViews(v);
          // 这次取到了就清掉上次失败的红字
          setError('');
        })
        .catch((e: unknown) => live && setError(errorMessage(e)));
    void read();
    const timer = setInterval(() => void read(), 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  // 改凭据要在超级管理员模式里（本机管理员一直算在模式里）；没进时只看连接状态，顶上给入口
  const changing = !!useAuthState()?.actor?.superAdminMode;
  return (
    <div className="channel-list">
      <SuperModeNotice what="填写或更换机器人凭据、连接和断开" />
      {error && (
        <p className="channel-error" role="alert">
          {error}
        </p>
      )}
      {views?.map((view) => <BotCard key={view.channel} view={view} onSaved={setViews} changing={changing} />)}
    </div>
  );
}
