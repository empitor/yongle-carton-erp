// 设置页的请求：AI 设置（密钥、余额、识别并发）、提示词预设、消息接入的机器人。
// AI 设置和提示词按接口表（shared/ai 的 AiSettingsApi、PromptApi）给地址、正文和回答的类型；写入带这两页自己的页面凭证
// （请求头 X-ERP-AI-Token），src/ui 的 call() 不带这个请求头，所以经 tokenRequest 发；读取同样经 tokenRequest（不缓存、不带凭证）。
import type { z } from 'zod';
import type {
  AiSettingsApi,
  PromptAction,
  PromptApi,
  PromptModuleId,
  promptSaveSchema,
  promptTargetSchema,
} from '../../shared/ai/index';
import type { BotChannel, InboxApi } from '../../shared/import/index';
import { call, responseData, tokenRequest } from '../ui/index';

const inbox = call<InboxApi>();

type Api = AiSettingsApi & PromptApi;
type Key = keyof Api;
/** 写接口（带正文的键）和各自的正文 */
type WriteKey = { [K in Key]: Api[K] extends { body: unknown } ? K : never }[Key];
type Bodies = { [K in WriteKey]: Api[K]['body'] };
type ReadKey = Exclude<Key, WriteKey>;
/** 一种提示词动作的正文（各模块一样，照服务端的规则写）：保存带整份预设，别的按编号点一份 */
type PromptBody<A extends PromptAction> = z.input<A extends 'save' ? typeof promptSaveSchema : typeof promptTargetSchema>;
/** 提示词动作的回答：这个模块改好以后的整份设置 */
type PromptReply = Api[`POST /ai/prompt-modules/${PromptModuleId}/${PromptAction}`]['response'];

/** 键里的地址（“方法 /…”去掉方法，前面接上 /api） */
const urlOf = (key: Key) => '/api' + key.slice(key.indexOf(' ') + 1);
/** 出错时错误带着类别 code（authentication、network……），页面按类别给短标签 */
const read = <K extends ReadKey>(key: K, failure: string) =>
  tokenRequest(urlOf(key), '').then((r) => responseData<Api[K]['response']>(r, failure));
const write = <K extends WriteKey>(key: K, token: string, body: Bodies[K], failure: string) =>
  tokenRequest(urlOf(key), token, body).then((r) => responseData<Api[K]['response']>(r, failure));

const SETTINGS_FAILURE = 'ERP 请求失败';
export const readAiSettings = () => read('GET /ai/settings', SETTINGS_FAILURE);
/** 查余额（免费，不改配置） */
export const readAiBalance = (token: string) => write('POST /ai/settings/balance', token, {}, SETTINGS_FAILURE);
/** 保存密钥：test 为真先查一次余额确认密钥对再存（回答带余额），否则只存 */
export const saveAiKey = (
  token: string,
  test: boolean,
  body: Bodies['POST /ai/settings/key'],
): Promise<Api['POST /ai/settings/key']['response']> =>
  test
    ? write('POST /ai/settings/key', token, body, SETTINGS_FAILURE)
    : write('POST /ai/settings/key/save', token, body, SETTINGS_FAILURE);
/** 用已存的密钥重新测试（查余额） */
export const retestAiKey = (token: string, expectedRevision: number) =>
  write('POST /ai/settings/test', token, { expectedRevision }, SETTINGS_FAILURE);
export const saveAiPreferences = (token: string, body: Bodies['POST /ai/settings/preferences']) =>
  write('POST /ai/settings/preferences', token, body, SETTINGS_FAILURE);
export const removeAiKey = (token: string, expectedRevision: number) =>
  write('POST /ai/settings/key/delete', token, { confirmed: true, expectedRevision }, SETTINGS_FAILURE);

/** 一个模块的提示词预设（/api/ai/prompt-modules/模块） */
export const readPrompts = (module: PromptModuleId) =>
  read(`GET /ai/prompt-modules/${module}`, '无法读取提示词预设');
export const changePrompts = <A extends PromptAction>(module: PromptModuleId, action: A, token: string, body: PromptBody<A>) =>
  tokenRequest(urlOf(`POST /ai/prompt-modules/${module}/${action}`), token, body).then((r) =>
    responseData<PromptReply>(r, '操作失败'),
  );

/** 消息接入：各家机器人的设置和连接状态 */
export const readBots = () => inbox('GET /inbox/bots');
export const saveBot = (channel: BotChannel, body: InboxApi['POST /inbox/bots/:channel']['body']) =>
  inbox('POST /inbox/bots/:channel', { params: { channel }, body });
