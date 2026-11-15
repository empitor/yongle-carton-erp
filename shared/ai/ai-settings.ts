/** AI 设置：只有一个 DeepSeek 密钥和识别并发数。错误类别和设置页、各业务页看到的状态。 */
export type AiFailureCode =
  | 'validation'
  | 'network'
  | 'timeout'
  | 'authentication'
  | 'quota'
  | 'rate_limit'
  | 'permission'
  | 'too_large'
  | 'unreadable'
  | 'upstream'
  | 'response'
  | 'content_filter'
  | 'busy'
  | 'stale'
  | 'key_required'
  | 'storage';
/**
 * 密钥状态：missing 没填；saved 存了还没检查；ok 查余额通过；low-balance 密钥对但余额不足；
 * invalid 密钥不对；failed 检查时连不上或别的错误。
 */
export type AiKeyState = 'missing' | 'saved' | 'ok' | 'low-balance' | 'invalid' | 'failed';
export type AiKeyCheck = { state: AiKeyState; message: string; code?: AiFailureCode; checkedAt?: string };
export type AiSettingsView = {
  csrfToken: string;
  revision: number;
  /** 固定的模型名，只是显示 */
  model: string;
  hasKey: boolean;
  keySavedAt: string | null;
  check: AiKeyCheck;
  /** 同时识别文件数，1～6，默认 3 */
  recognitionConcurrency: number;
  storageError: string | null;
};
/** 给业务页面、助手和语音按钮：ready 表示存了密钥且这台服务器解得开。 */
export type AiStatus = { ready: boolean; model: string; message: string };
export type AiBalance = {
  available: boolean;
  balances: { currency: string; total: string; granted: string; toppedUp: string }[];
  checkedAt: string;
};
