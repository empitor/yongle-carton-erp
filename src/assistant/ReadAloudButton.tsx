import { LoaderCircle, Square, Volume2 } from 'lucide-react';
import type { ReadAloud } from './useReadAloud';

/**
 * 助手回复右下角的“读出来”小喇叭。点一下读，读的时候再点停；准备中转圈（点了也是停）。
 * 用不了（没填密钥）时按钮仍在、显示为不可用，点了说明原因；出错的原因写在按钮旁边。
 * 状态都在 useReadAloud 里，一个助手窗口一份，所有消息共用（同一时间只读一条）。
 */
export function ReadAloudButton({
  reader,
  threadId,
  messageId,
}: {
  reader: Pick<ReadAloud, 'messageId' | 'phase' | 'error' | 'unavailable' | 'toggle'>;
  threadId: string;
  messageId: string;
}) {
  const phase = reader.messageId === messageId ? reader.phase : 'idle';
  const error = reader.error?.messageId === messageId ? reader.error.message : '';
  const label = phase === 'idle' ? '读出来' : '停止朗读';
  const title =
    reader.unavailable ||
    (phase === 'loading' ? '正在准备朗读，点一下停止' : phase === 'playing' ? '停止朗读' : '读出来（由 DeepSeek 朗读这条回复）');
  return (
    <span className="ga-read-aloud">
      <button
        type="button"
        className={'icon-button ga-read-aloud-button' + (phase === 'idle' ? '' : ' active')}
        aria-label={label}
        aria-pressed={phase !== 'idle'}
        aria-disabled={reader.unavailable ? true : undefined}
        title={title}
        onClick={() => reader.toggle(threadId, messageId)}
      >
        {phase === 'loading' ? (
          <LoaderCircle className="spin" size={15} />
        ) : phase === 'playing' ? (
          <Square size={13} />
        ) : (
          <Volume2 size={15} />
        )}
      </button>
      {error && (
        <small className="ga-read-aloud-error" role="alert">
          {error}
        </small>
      )}
    </span>
  );
}
