import type { MessageView } from '../../shared/assistant/index';
import type { useConfirm } from '../ui/index';
import type { useAssistantUploads } from './useAssistantUploads';
import type { useAssistantSpeech } from './useAssistantSpeech';

/**
 * 助手聊天窗口各块共用的类型，放在最底下：hook、展示块、GlobalAssistant 都从这里拿，互相之间不为类型引用。
 */

/** 聊天里的一份附件（会话里的，或刚传上去的）：shared/core 的 AssistantAttachment */
export type ChatAttachment = MessageView['attachments'][number];

/** 附件预览窗口：看哪几份、先看哪一份；没打开是 null */
export type PreviewFiles = { files: ChatAttachment[]; id: string } | null;

/** 悬浮小人让到哪边；panel 是压住了右侧详情面板，缩到最右只留一条小边；不用让是 null */
/** 让开的样子：缩到左 / 右边露脸；压住详情面板缩成一条、面板让出这条（panel）；贴在右边时压住表格、按钮也缩成一条（edge） */
export type YieldSideState = 'left' | 'right' | 'panel' | 'edge' | null;

/** 待发附件（useAssistantUploads 的返回值） */
export type AssistantUploads = ReturnType<typeof useAssistantUploads>;

/** 语音输入（useAssistantSpeech 的返回值） */
export type AssistantSpeech = ReturnType<typeof useAssistantSpeech>;

/** 页面上的确认窗口（useConfirm 给的第二项） */
export type ConfirmFn = ReturnType<typeof useConfirm>[1];

/** 思考过程的一段：第几轮模型调用、这一轮想了什么（流式拼起来的） */
export type ReasoningPart = { round: number; text: string };

/** 正在生成的这次回复的思考过程：已收到的内容和想了多少字 */
export type LiveReasoning = { parts: ReasoningPart[]; chars: number };

/** 人在确认卡片上的决定（发给服务器让助手接着办） */
export type CardDecision = { id: string; decision: 'confirmed' | 'rejected' };
/** 一轮回复里服务器实际做了什么（shared/assistant 的 TurnFacts） */
export type { TurnFacts } from '../../shared/assistant/index';
