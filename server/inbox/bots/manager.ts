/**
 * 三家机器人的总管：按设置库给每家建一条连接，统一启停；某一家保存设置后只重连那一家。
 * 也给接口、收件箱来源列表、助手的设置视图出数据（不含 Secret 和应用编号以外的凭据）。
 */
import {
  botChannels,
  inboxChannelLabels,
  type BotChannel,
  type BotStatus,
  type BotView,
  type InboxChannelOption,
  type InboxIncoming,
} from '../../../shared/import/index.js';
import { BotConnection, type BotConnectionOptions } from './connection.js';
import type { BotProtocol, ProtocolDeps } from './protocol.js';
import type { BotSettings } from './settings.js';
import { wecomProtocol } from './wecom.js';
import { feishuProtocol } from './feishu.js';
import { dingtalkProtocol } from './dingtalk.js';

/** 测试和预览把请求、WebSocket 换成本机假服务端；生产都不传。 */
export type BotManagerOptions = {
  ingest: (incoming: InboxIncoming) => unknown;
  exists: BotConnectionOptions['exists'];
} & ProtocolDeps &
  Pick<BotConnectionOptions, 'WebSocketImpl' | 'sleep'>;

/** 总管对一条连接只做这几件事（三家的连接下载、回复要的信息各不相同，总管不管） */
type ManagedConnection = { start(): void; stop(): void; idle(): Promise<void>; status(): BotStatus };

export class BotManager {
  private connections = new Map<BotChannel, ManagedConnection>();
  constructor(
    readonly settings: BotSettings,
    options: BotManagerOptions,
  ) {
    const { fetchImpl, checkHost, ...rest } = options,
      deps = { fetchImpl, checkHost };
    const add = <M, R>(protocol: BotProtocol<M, R>) =>
      this.connections.set(
        protocol.channel,
        new BotConnection(protocol, { ...rest, credentials: () => settings.credentials(protocol.channel) }),
      );
    add(wecomProtocol(deps));
    add(feishuProtocol(deps));
    add(dingtalkProtocol(deps));
  }
  private connection(channel: BotChannel) {
    const found = this.connections.get(channel);
    if (!found) throw new Error('没有这家机器人的连接：' + channel);
    return found;
  }
  start() {
    for (const connection of this.connections.values()) connection.start();
  }
  stop() {
    for (const connection of this.connections.values()) connection.stop();
  }
  /** 保存设置后重新连这一家（停用了就断开）。 */
  restart(channel: BotChannel) {
    this.connection(channel).start();
  }
  /** 测试和关闭时等待已收到的消息处理完。 */
  idle() {
    return Promise.all([...this.connections.values()].map((c) => c.idle()));
  }
  views(): BotView[] {
    return botChannels.map((channel) => ({
      channel,
      label: inboxChannelLabels[channel],
      ...this.settings.view(channel),
      status: this.connection(channel).status(),
    }));
  }
}

/** 收件箱的来源：手动添加和三家机器人（填好凭据、启用了才算配好）。没接上总管时机器人都算没配。 */
export function inboxChannelList(bots?: BotManager): InboxChannelOption[] {
  const views = new Map(bots?.views().map((v) => [v.channel, v]));
  return [
    { id: 'manual', label: inboxChannelLabels.manual, configured: true },
    ...botChannels.map((channel) => {
      const view = views.get(channel);
      return {
        id: channel,
        label: inboxChannelLabels[channel],
        configured: !!view && view.enabled && view.hasSecret,
        state: view?.status.state ?? 'off',
      };
    }),
  ];
}
