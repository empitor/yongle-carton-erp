import { useRef } from 'react';
import { isPhoneNow } from './phone';

/** 只看事件落在谁身上：暗层自己，还是暗层里的窗口 */
type BackdropEvent = { target: EventTarget; currentTarget: EventTarget };

/**
 * 手机样式下点窗口背后的暗处关窗（小窗口从下面升起，和手机系统的半屏窗口一样）：和点右上角的 × 走同一个 close，
 * × 点不了（busy，正在提交）时暗处也不关。电脑上居中的窗口点暗处不关，只能点 ×（用户定的）。
 * 按下和抬起都落在暗处才算，在窗口里按住拖到暗处松手（选文字、拖滚动条）不关。
 * 是不是手机样式和样式表用同一个判断（phone.ts），点的那一刻再看，屏幕转过来、窗口拉宽都跟着变。
 */
export function useBackdropClose(close: () => void, busy: boolean) {
  const pressed = useRef(false);
  return {
    onPointerDown: (e: BackdropEvent) => {
      pressed.current = e.target === e.currentTarget;
    },
    onClick: (e: BackdropEvent) => {
      const onBackdrop = pressed.current && e.target === e.currentTarget;
      pressed.current = false;
      if (onBackdrop && !busy && isPhoneNow()) close();
    },
  };
}
