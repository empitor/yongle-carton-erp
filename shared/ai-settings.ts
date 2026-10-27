import { z } from 'zod';

export const aiProviders = [
  {
    id: 'openai',
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    protocol: 'Responses API',
    requiresKey: true,
    implemented: true,
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash',
    protocol: 'Gemini 原生 API',
    requiresKey: true,
    implemented: true,
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    endpoint: 'https://api.anthropic.com/v1',
    model: 'claude-haiku-4-5',
    protocol: 'Messages API',
    requiresKey: true,
    implemented: true,
  },
  {
    id: 'compatible',
    name: '自定义兼容 API',
    endpoint: '',
    model: '',
    protocol: 'OpenAI Chat Completions / Responses API',
    requiresKey: true,
    implemented: true,
  },
  {
    id: 'ollama',
    name: 'Ollama 本地模型',
    endpoint: 'http://127.0.0.1:11434',
    model: '',
    protocol: 'Ollama 原生 Chat API',
    requiresKey: false,
    implemented: true,
  },
] as const;
export const providerIdSchema = z.enum(['openai', 'gemini', 'anthropic', 'compatible', 'ollama']);
export type ProviderId = z.infer<typeof providerIdSchema>;
export const apiStyleSchema = z.enum(['chat-completions', 'responses']);
export type ApiStyle = z.infer<typeof apiStyleSchema>;
export const profileSchema = z.strictObject({
  provider: providerIdSchema,
  endpoint: z.string().trim().min(1).max(500),
  model: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/,
      '模型名称只能包含字母、数字、点、下划线、冒号、斜杠和短横线',
    ),
  apiStyle: apiStyleSchema.optional(),
});
export type AiProfile = z.infer<typeof profileSchema>;
export type PublicProfile = AiProfile & { hasApiKey: boolean; lastTestAt: string | null };
export type AiFailureCode =
  | 'validation'
  | 'endpoint'
  | 'network'
  | 'dns'
  | 'tls'
  | 'timeout'
  | 'gateway_timeout'
  | 'authentication'
  | 'permission'
  | 'model'
  | 'quota'
  | 'rate_limit'
  | 'upstream'
  | 'response'
  | 'busy'
  | 'stale'
  | 'key_required'
  | 'storage';
export type ConnectionResult = {
  ok: true;
  testedAt: string;
  durationMs: number;
  testToken: string;
  message: string;
};
export type AiSettingsView = {
  recognitionConcurrency?:number;
  csrfToken: string;
  revision: number;
  storage: 'windows-dpapi';
  storageError: string | null;
  presets: PublicPreset[];
  active: PublicPreset | null;
  lastPresetId: string | null;
  autoConnect: boolean;
  connection: ApiConnectionState;
};
export type PublicPreset = {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  hasApiKey: boolean;
  lastTestAt: string | null;
  apiStyle?: ApiStyle;
};
export type ApiConnectionState = {
  presetId: string | null;
  status: 'idle' | 'checking' | 'verified' | 'unverified' | 'failed' | 'model-tested';
  message: string;
  code?: AiFailureCode;
  checkedAt?: string;
};
export const presetInputSchema = z.strictObject({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(60),
  endpoint: z.string().trim().min(1).max(500),
  apiStyle: apiStyleSchema.default('chat-completions'),
  model: profileSchema.shape.model.or(z.literal('')).default(''),
  apiKey: z.string().max(4096).optional(),
  expectedRevision: z.number().int().nonnegative(),
});
export type PresetInput = z.infer<typeof presetInputSchema>;
