import type { CSSProperties } from 'react';
import { speakerNames, type AssistantSpeaker } from '../../shared/assistant/index';
import { assistantDisplayName } from './assistant-launcher';
import type { FloatingDock } from './floating-assistant';
import type { useFloatingAssistant } from './useFloatingAssistant';
import YlSpirits from './YlSpirits';
import type { YieldSideState } from './assistant-types';

/**
 * 收起时的悬浮小人按钮（只显示）：小甬小勒、拖动和让位时的样子、新回复的气泡、AI 正在处理的标记。
 * 位置和让位由 useFloatingAssistant、useMascotYield 算好传进来。
 */
export default function AssistantLauncher({
  floating,
  yieldSide,
  pose,
  style,
  busy,
  speaker,
  speakTick,
  bubble,
  onOpen,
}: {
  floating: ReturnType<typeof useFloatingAssistant>;
  yieldSide: YieldSideState;
  pose: FloatingDock;
  style: CSSProperties;
  busy: boolean;
  speaker: AssistantSpeaker | undefined;
  speakTick: number;
  bubble: { speaker: AssistantSpeaker; text: string } | null;
  onOpen: () => void;
}) {
  return (
    <button
      ref={floating.elementRef}
      className={
        'ga-launcher' +
        (floating.moving ? ' ga-moving' : '') +
        (yieldSide ? ' ga-yield ga-yield-' + yieldSide : '')
      }
      data-dock={pose}
      aria-label={'打开' + assistantDisplayName}
      aria-haspopup="dialog"
      aria-expanded={false}
      title={assistantDisplayName + ' · 点击聊天，拖到左右边缘可半隐藏；方向键也可移动'}
      style={style}
      {...floating.bind}
      onClickCapture={floating.onClickCapture}
      onClick={onOpen}
    >
      <YlSpirits
        pose={pose}
        busy={busy}
        moving={floating.moving}
        speaker={speaker}
        speakTick={speakTick}
      />
      {bubble && (
        <span className="yl-bubble" role="status">
          <b>{speakerNames[bubble.speaker]}</b>
          {bubble.text}
        </span>
      )}
      {busy && <i aria-label="AI正在处理" />}
    </button>
  );
}
