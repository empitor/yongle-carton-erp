import {
  isWebLink,
  readSpeaker,
  speakerNames,
  type AssistantSpeaker,
  type InterimSaid,
  type WebSource,
} from '../../shared/assistant/index';
import { SpeakerAvatar } from './YlSpirits';

/**
 * 一轮回复的过程（只显示）：模型调命令前先说的那几段话（照普通助手的话显示，换了说话人才写是谁）、
 * 回答下面可展开的“来源 N 个”（联网搜到的、读过全文的网页）。
 */

/** 先说的话：speaker 是这条回复的说话人，同一人说的不再重复写名字 */
export function InterimParts({ parts, speaker }: { parts: InterimSaid[] | undefined; speaker?: AssistantSpeaker }) {
  return (
    <>
      {parts?.map((part, index) => {
        const who = readSpeaker(part.speaker);
        return (
          <div className="ga-interim" key={index}>
            {who && who !== speaker && (
              <small className="ga-who">
                <SpeakerAvatar speaker={who} />
                {speakerNames[who]}
              </small>
            )}
            <div className="ga-text">{part.text}</div>
          </div>
        );
      })}
    </>
  );
}

/**
 * 回答下面的来源：默认收起，展开是链接列表（标题 · 网址的真实主机 · 日期），新标签页打开。
 * 标题是外来文字，可能冒充别的网站，所以小字写的是链接真正指向的主机；只给 http、https 的网址做链接。
 */
export function SourceList({ sources }: { sources: WebSource[] | undefined }) {
  if (!sources?.length) return null;
  return (
    <details className="ga-sources">
      <summary>来源 {sources.length} 个</summary>
      <ol>
        {sources.map((s) => {
          const href = isWebLink(s.url) ? s.url : null;
          const meta = [href && new URL(href).host, s.date, s.read ? '已读全文' : ''].filter(Boolean).join(' · ');
          return (
            <li key={s.url}>
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {s.title || href}
                </a>
              ) : (
                <span>{s.title}</span>
              )}
              {meta && <small> · {meta}</small>}
            </li>
          );
        })}
      </ol>
    </details>
  );
}
