// 外壳页面的读取：使用说明页的手册、设置页给非管理员看的 AI 状态。登录和改密码在 auth-api.ts。
import type { AssistantApi } from '../shared/assistant/index';
import type { GuideApi } from '../shared/core/index';
import { call } from './ui/index';

const assistant = call<AssistantApi>();
const guide = call<GuideApi>();

/** 读整份使用手册（GET /api/guide） */
export const readGuide = () => guide('GET /guide');

/** 现在用的模型、管理员填没填密钥（GET /api/assistant 里的 ai） */
export const readAiStatus = async () => (await assistant('GET /assistant')).ai;
