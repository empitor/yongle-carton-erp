/*
 * 浏览器的音频环境（录音 capture.ts、朗读 useReadAloud.ts 用）。老版本 Safari 只有带前缀的 webkitAudioContext，
 * 标准库的 Window 类型里没有它，在这里补上声明，不在用处断言。
 */
declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

/** 浏览器的音频环境类；都没有时没有（录音、朗读按不支持处理） */
export function browserAudioContext(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.AudioContext || window.webkitAudioContext;
}
