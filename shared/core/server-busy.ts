/**
 * 服务器正忙：验密码（登录、进超级管理员模式、改密码、删除确认）排队的人满了或等超时、输错计数表满了时，
 * 服务端回 429、这个代码和这句话，带 Retry-After；页面收到后停一下自动再发一次，第二次还忙才显示（src/ui/http.ts）。
 * 这时什么都没办，重发不会办两次；也不算输错。
 */
export const SERVER_BUSY_CODE = 'busy';
export const SERVER_BUSY_MESSAGE = '服务器正忙，请稍后再试。';
/** 回给页面的 Retry-After（秒），页面按它等了再自动重发一次 */
export const SERVER_BUSY_RETRY_SECONDS = 1;
