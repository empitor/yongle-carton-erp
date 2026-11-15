import type { RefObject } from 'react';
import { useIsPhone } from '../ui/index';
import { sendsOnEnter } from './composer-keys';
import type { AssistantSpeech, AssistantUploads } from './assistant-types';

type Props = {
  composer: RefObject<HTMLTextAreaElement | null>;
  message: string;
  setMessage: (message: string) => void;
  busy: boolean;
  speech: AssistantSpeech;
  uploads: AssistantUploads;
  /** 发送按钮能不能点；回车发送的条件和它一样 */
  canSend: boolean;
  onSend: () => void;
};

/** 输入框：电脑上回车发送、Shift+回车换行（手机回车换行）；粘贴图片当附件 */
export function ComposerInput({ composer, message, setMessage, busy, speech, uploads, canSend, onSend }: Props) {
  const phone = useIsPhone();
  return (
    <textarea
      ref={composer}
      aria-label="给小甬小勒的消息"
      value={message}
      maxLength={6000}
      disabled={busy}
      // 输入框窄，电脑上的提示只说怎么发送和换行，分两行写正好放下（问什么，上面的开场白有例子）
      placeholder={phone ? '输入业务问题或修改要求…' : '回车发送\nShift+回车换行'}
      onChange={(e) => setMessage(e.target.value)}
      onKeyDown={(e) => {
        if (!sendsOnEnter({ ...e, isComposing: e.nativeEvent.isComposing }, phone)) return;
        // 不该发的时候回车也不换行
        e.preventDefault();
        if (canSend) onSend();
      }}
      onPaste={(e) => {
        if (speech.active) return;
        const images = pastedImages(e.clipboardData);
        if (images.length) {
          e.preventDefault();
          void uploads.add(images);
        }
      }}
    />
  );
}

/** 剪贴板里的图片当附件：起名“剪贴板-时间-序号.扩展名” */
function pastedImages(clipboard: DataTransfer) {
  return [...clipboard.items]
    .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
    .map((i) => i.getAsFile())
    .filter((f): f is File => !!f)
    .map(
      (f, i) =>
        new File(
          [f],
          '剪贴板-' + Date.now() + '-' + i + '.' + (f.type === 'image/jpeg' ? 'jpg' : f.type === 'image/webp' ? 'webp' : 'png'),
          { type: f.type },
        ),
    );
}
