import { reasoningText } from './chat-stream';
import type { ReasoningPart } from './assistant-types';

/**
 * 回复上方折叠的思考过程（只显示）。生成中（给了 liveChars）标题是“正在思考 · N 字”，思考内容还没到时只是一行字；
 * 回复完成后标题是“思考过程”，默认收起，点开看内容。多轮工具调用时每轮一段，段与段之间空一行。
 * 什么都没有时不放东西。
 */
export default function ReasoningFold({
  parts,
  liveChars,
}: {
  parts: ReasoningPart[] | undefined;
  liveChars?: number;
}) {
  const live = liveChars !== undefined;
  const text = parts?.length ? reasoningText(parts) : '';
  if (live && !liveChars && !text) return null;
  if (!live && !text) return null;
  const title = live ? '正在思考 · ' + liveChars + ' 字' : '思考过程';
  if (!text) return <p className="ga-reasoning ga-reasoning-live">{title}</p>;
  return (
    <details className={'ga-reasoning' + (live ? ' ga-reasoning-live' : '')}>
      <summary>{title}</summary>
      <div className="ga-reasoning-text">{text}</div>
    </details>
  );
}
