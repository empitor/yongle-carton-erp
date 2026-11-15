// 对话消息的类型（识别的填表和助手的原生工具调用共用）。发请求在 chat-tools.ts。
export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'high' | 'auto' | 'low' } }
  | { type: 'file'; file_id: string };
export type ChatMessage =
  | { role: 'system' | 'assistant'; content: string }
  | { role: 'user'; content: string | ChatPart[] }
  /** 日期等用户元信息，必须紧挨在它那条 user 前面（官方“用户元信息标记”） */
  | { role: 'latest_reminder'; content: string };
