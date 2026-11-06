import { useId } from 'react';
import type { FloatingDock } from './floating-assistant';

const OUTLINE = '#7a5530';
const INK = '#33261c';

/** 原创矢量形象：正面纸箱，翻盖像两只耳朵，头顶一颗紫色小星代表 AI。 */
export default function CartonSpirit({ pose = 'free' }: { pose?: FloatingDock }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg
      className="ga-spirit"
      data-pose={pose}
      viewBox="0 0 100 112"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={id + 'body'} x1="50" y1="41" x2="50" y2="92" gradientUnits="userSpaceOnUse">
          <stop stopColor="#f3d6a6" />
          <stop offset="1" stopColor="#e0b57c" />
        </linearGradient>
        <linearGradient id={id + 'flap'} x1="50" y1="24" x2="50" y2="42" gradientUnits="userSpaceOnUse">
          <stop stopColor="#f7e0b8" />
          <stop offset="1" stopColor="#e6c08a" />
        </linearGradient>
        <linearGradient id={id + 'spark'} x1="50" y1="5" x2="50" y2="23" gradientUnits="userSpaceOnUse">
          <stop stopColor="#c4b5fd" />
          <stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
      </defs>
      <ellipse
        className="ga-spirit-shadow"
        cx="50"
        cy="104"
        rx="26"
        ry="3.6"
        fill="#1c1208"
        opacity=".2"
      />
      <g className="ga-spirit-pose">
        <g className="ga-spirit-peek">
          <g className="ga-spirit-body">
            {/* 脚 */}
            <rect x="33" y="85" width="12" height="16" rx="6" fill="#c99a60" stroke={OUTLINE} strokeWidth="1.6" />
            <rect x="55" y="85" width="12" height="16" rx="6" fill="#c99a60" stroke={OUTLINE} strokeWidth="1.6" />
            {/* 手：外圈描边 + 内圈填色，和身体同一套线条 */}
            <g className="ga-spirit-hand" strokeLinecap="round">
              <path d="M25 68Q17 66 13 56" stroke={OUTLINE} strokeWidth="9.4" />
              <path d="M25 68Q17 66 13 56" stroke="#e6c08a" strokeWidth="6.2" />
            </g>
            <g className="ga-spirit-rest-hand" strokeLinecap="round">
              <path d="M75 68Q83 70 86 77" stroke={OUTLINE} strokeWidth="9.4" />
              <path d="M75 68Q83 70 86 77" stroke="#d7ab72" strokeWidth="6.2" />
            </g>
            {/* 纸箱开口和后盖 */}
            <path
              d="M31 33L35 25Q36 23 38 23H62Q64 23 65 25L69 33Z"
              fill="#d3a56b"
              stroke={OUTLINE}
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
            <path d="M26 42L31 32H69L74 42Z" fill="#6f4b2a" stroke={OUTLINE} strokeWidth="1.6" strokeLinejoin="round" />
            {/* 两侧翻盖 */}
            <path
              d="M26 42L31 32L14 27Q9 26 8.6 31L9 35Q9 37 11 37.4Z"
              fill={'url(#' + id + 'flap)'}
              stroke={OUTLINE}
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
            <path
              d="M74 42L69 32L86 27Q91 26 91.4 31L91 35Q91 37 89 37.4Z"
              fill={'url(#' + id + 'flap)'}
              stroke={OUTLINE}
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
            {/* 箱身 */}
            <rect x="22" y="41" width="56" height="51" rx="9" fill={'url(#' + id + 'body)'} stroke={OUTLINE} strokeWidth="1.8" />
            <path d="M72 42.5Q77 44 77 50V83Q77 89 72 90.5Z" fill="#c9985c" opacity=".38" />
            <path d="M28 45.5H72" stroke="#fff4dc" strokeWidth="2" strokeLinecap="round" opacity=".7" />
            {/* 封箱胶带 */}
            <path d="M44.5 41.5H55.5V50.5L53 49L50 50.8L47 49L44.5 50.5Z" fill="#f8ebcf" stroke="#c49a63" strokeWidth="1" strokeLinejoin="round" />
            {/* 右下角箱唛刻线 */}
            <path d="M61 85H69M63.5 81.5H69" stroke="#a97f4c" strokeWidth="1.5" strokeLinecap="round" opacity=".7" />
            <g className="ga-spirit-face">
              <ellipse cx="31" cy="72" rx="4.8" ry="2.8" fill="#ef9273" opacity=".6" />
              <ellipse cx="69" cy="72" rx="4.8" ry="2.8" fill="#ef9273" opacity=".6" />
              <g className="ga-spirit-gaze">
                <g className="ga-spirit-eyes">
                  <ellipse cx="39" cy="63.5" rx="5.2" ry="6" fill={INK} />
                  <ellipse cx="61" cy="63.5" rx="5.2" ry="6" fill={INK} />
                  <circle cx="41" cy="61" r="2" fill="#fff" />
                  <circle cx="63" cy="61" r="2" fill="#fff" />
                  <circle cx="37.6" cy="66" r="1" fill="#fff" opacity=".85" />
                  <circle cx="59.6" cy="66" r="1" fill="#fff" opacity=".85" />
                </g>
              </g>
              <path
                d="M45 70.5Q50 72 55 70.5Q54.4 76.2 50 76.2Q45.6 76.2 45 70.5Z"
                fill="#8c3f2b"
                stroke={INK}
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
            </g>
            {/* AI 小星 */}
            <g className="ga-spirit-spark">
              <path
                d="M50 4.5Q51.4 12.6 59 14Q51.4 15.4 50 23.5Q48.6 15.4 41 14Q48.6 12.6 50 4.5Z"
                fill={'url(#' + id + 'spark)'}
              />
              <circle cx="61.5" cy="7.5" r="1.7" fill="#a78bfa" />
            </g>
          </g>
        </g>
      </g>
      {/* 只有手分左右；箱身和五官不做镜像。 */}
      <g className="ga-spirit-grip ga-spirit-grip-left">
        <g transform="translate(0 15)">
          <path
            d="M49 64C56 60 63 63 63 69L62 76Q61 80 55 79L49 77Z"
            fill="#e6c08a"
            stroke={OUTLINE}
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path d="M51 68L57 69M51 72.5L56 73.5" stroke="#a97f4c" strokeWidth="1.3" strokeLinecap="round" />
        </g>
      </g>
      <g className="ga-spirit-grip ga-spirit-grip-right">
        <g transform="translate(0 15)">
          <path
            d="M51 64C44 60 37 63 37 69L38 76Q39 80 45 79L51 77Z"
            fill="#e6c08a"
            stroke={OUTLINE}
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path d="M49 68L43 69M49 72.5L44 73.5" stroke="#a97f4c" strokeWidth="1.3" strokeLinecap="round" />
        </g>
      </g>
    </svg>
  );
}
