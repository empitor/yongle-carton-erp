// 外壳页面的读取：设置页给非管理员看的 AI 状态。登录和改密码在 auth-api.ts，使用说明页的手册在 system/guide-api.ts。
import type { AssistantApi } from '../shared/assistant/index';
import { call } from './ui/index';

const assistant = call<AssistantApi>();

/** 现在用的模型、管理员填没填密钥（GET /api/assistant 里的 ai） */
export const readAiStatus = async () => (await assistant('GET /assistant')).ai;
