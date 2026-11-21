// 使用说明页的读取（接口表 shared/system/guide-api.ts）
import type { GuideApi } from '../../shared/system/index';
import { call } from '../ui/index';

const guide = call<GuideApi>();

/** 读整份使用手册（GET /api/guide） */
export const readGuide = () => guide('GET /guide');
