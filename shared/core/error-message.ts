/**
 * 接住的出错（catch 里是 unknown）里给人看的那句话：错误对象取 message，字符串原样，带 message 文字的对象取它，别的转成文字。
 * 全项目用它，不再写 `(e as Error).message`：抛出来的不是 Error 时那种写法会得到 undefined。
 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string') return e.message;
  return String(e);
}
