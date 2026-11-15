// 由 scripts/schema-rows.ts 按建表生成（npm run schema:dump），不要手改；tests/schema-evolution.test.ts 核对它和建表一致。
// 类型按声明的列类型：INTEGER、REAL 是 number，TEXT 是 string，BLOB 是 Uint8Array；NOT NULL 和主键以外的列可空。
import { z } from 'zod';

/** 配置库（各自一个文件，不在业务库里）：一张表一个行结构 */
export const configRows = {
  // AI 设置库
  ai_settings: z.object({
    id: z.number(),
    document: z.string(),
  }),
  // AI 识别工作区
  workspaces: z.object({
    id: z.string(),
    file_hash: z.string(),
    revision: z.number(),
    document: z.string(),
  }),
  recognition_failures: z.object({
    id: z.string(),
    workspace_id: z.string().nullable(),
    recorded_at: z.string(),
    legacy_key: z.string().nullable(),
    document: z.string(),
  }),
  // 出错记录库
  recent_problems: z.object({
    id: z.number(),
    at: z.string(),
    source: z.string(),
    account: z.string().nullable(),
    method: z.string(),
    path: z.string(),
    operation: z.string(),
    category: z.string(),
    status: z.number(),
    message: z.string(),
    reason: z.string(),
    stack: z.string(),
    page: z.string(),
  }),
  // 助手工具设置库
  tool_settings: z.object({
    name: z.string(),
    enabled: z.number(),
    updated_at: z.string(),
  }),
  tool_settings_revision: z.object({
    id: z.number(),
    revision: z.number(),
  }),
  assistant_account_settings: z.object({
    user_id: z.string(),
    name: z.string(),
    value: z.string(),
    updated_at: z.string(),
  }),
  assistant_memories: z.object({
    id: z.number(),
    user_id: z.string(),
    content: z.string(),
    source: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    used_at: z.string().nullable(),
    use_count: z.number(),
  }),
  // 提示词库
  prompt_settings: z.object({
    id: z.number(),
    revision: z.number(),
    document: z.string(),
  }),
  // 机器人设置库
  bots: z.object({
    channel: z.string(),
    app_id: z.string(),
    secret: z.string(),
    enabled: z.number(),
    updated_at: z.string(),
  }),
  // 账号库
  users: z.object({
    id: z.string(),
    name: z.string(),
    salt: z.string(),
    password_hash: z.string(),
    permissions: z.string(),
    role: z.string(),
    disabled_at: z.string().nullable(),
    must_change_password: z.number(),
    temp_password_expires: z.number().nullable(),
  }),
  auth_events: z.object({
    id: z.number(),
    at: z.string(),
    actor_id: z.string().nullable(),
    action: z.string(),
  }),
  account_requests: z.object({
    id: z.string(),
    kind: z.string(),
    name: z.string(),
    note: z.string(),
    salt: z.string().nullable(),
    password_hash: z.string().nullable(),
    client: z.string(),
    created_at: z.number(),
  }),
  auth_sessions: z.object({
    token_hash: z.string(),
    user_id: z.string(),
    expires: z.number(),
  }),
};
