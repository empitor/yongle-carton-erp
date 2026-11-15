/** 输入框按下的键里，判断要不要发送用到的几项（React 键盘事件和浏览器原生的都有这几项） */
export type PressedKey = {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** 输入法正在选字：这时的回车是上屏，不是发送 */
  isComposing: boolean;
};

/**
 * 这次按键是不是“回车发送”：电脑上单按回车。
 * Shift+回车换行；Ctrl、Cmd、Alt 加回车交给浏览器；手机键盘没有 Shift，回车保持换行。
 */
export function sendsOnEnter(pressed: PressedKey, phone: boolean) {
  const plain = !pressed.shiftKey && !pressed.ctrlKey && !pressed.metaKey && !pressed.altKey;
  return pressed.key === 'Enter' && plain && !pressed.isComposing && !phone;
}
