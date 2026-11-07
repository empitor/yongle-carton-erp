import { useEffect, useRef, useState } from 'react';
import type { FloatingDock } from './floating-assistant';
import type { AssistantSpeaker } from '../shared/assistant-personas';

/** 两人互动的小剧场，值是时长（毫秒），要和 yl-spirits.css 里的动画时长一致。 */
const scenes = {
  pass: 3600,
  whisper: 3000,
  highfive: 1700,
  nudge: 2400,
  stargaze: 3400,
  dance: 2400,
} as const;
type Scene = keyof typeof scenes;
const idleScenes = Object.keys(scenes) as Scene[];
const FIRST_SCENE_DELAY = 6000;
const reducedMotion = () =>
  typeof window !== 'undefined' &&
  !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** 聊天消息前的小头像：只画头和脸，不动。 */
export function SpeakerAvatar({ speaker }: { speaker: AssistantSpeaker }) {
  return speaker === 'yong' ? (
    <svg className="yl-avatar" viewBox="0 8 70 66" aria-hidden="true" focusable="false">
      <path fill="var(--teal)" d="M4 14H25L35 31 45 14H66L46 50V74H24V50Z" />
      <circle cx="29" cy="55" r="4.4" fill="#fff" />
      <circle cx="41" cy="55" r="4.4" fill="#fff" />
      <circle cx="29.9" cy="55.4" r="2.64" fill="#1b1a22" />
      <circle cx="41.9" cy="55.4" r="2.64" fill="#1b1a22" />
    </svg>
  ) : (
    <svg className="yl-avatar" viewBox="30 16 66 66" aria-hidden="true" focusable="false">
      <path fill="var(--kraft)" d="M50 56 73 19V82H50Z" />
      <circle cx="57.5" cy="56" r="4.4" fill="#fff" />
      <circle cx="68.5" cy="56" r="4.4" fill="#fff" />
      <circle cx="56.6" cy="56.4" r="2.64" fill="#1b1a22" />
      <circle cx="67.6" cy="56.4" r="2.64" fill="#1b1a22" />
    </svg>
  );
}

/**
 * 小甬（Y）和小勒（L）：商标长出了脸，站在一起还是商标。小勒的脚托着一只小纸箱，紫色小星代表 AI。
 * 两个精灵共用一个入口按钮，点哪个都打开同一个助手。
 * 每个精灵分四层：pose 管站位，enter 管出场，act 管动作和小剧场，breathe 管呼吸，互不覆盖。
 * still 用在手机底部导航这种小图标上，不动。compact 用在聊天窗口顶部，只做反应，不演小剧场。
 * speaker 是当前负责的人：处理中只有他干活，speakTick 每变一次他就跳一下。
 */
export default function YlSpirits({
  pose = 'free',
  busy = false,
  moving = false,
  still = false,
  compact = false,
  speaker,
  speakTick = 0,
}: {
  pose?: FloatingDock;
  busy?: boolean;
  moving?: boolean;
  still?: boolean;
  compact?: boolean;
  speaker?: AssistantSpeaker;
  speakTick?: number;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  const lastScene = useRef<Scene | null>(null);
  const firstScene = useRef(true);
  const wasBusy = useRef(busy);
  const [fresh, setFresh] = useState(!still && !compact);
  const [arrive, setArrive] = useState<'dock' | 'free' | null>(null);
  const lastPose = useRef(pose);
  const poseRef = useRef(pose);
  poseRef.current = pose;

  useEffect(() => {
    if (!fresh) return;
    const timer = window.setTimeout(() => setFresh(false), 900);
    return () => window.clearTimeout(timer);
  }, [fresh]);

  // 钻进屏幕边和蹦出来时多一段衔接动作。
  useEffect(() => {
    if (lastPose.current === pose) return;
    lastPose.current = pose;
    setArrive(pose === 'free' ? 'free' : 'dock');
    const timer = window.setTimeout(() => setArrive(null), 800);
    return () => window.clearTimeout(timer);
  }, [pose]);

  // AI 做完了：两个人击掌。
  useEffect(() => {
    if (wasBusy.current && !busy && !still && !compact && !reducedMotion()) setScene('highfive');
    wasBusy.current = busy;
  }, [busy, still, compact]);

  useEffect(() => {
    if (moving || busy) setScene(null);
  }, [moving, busy]);

  useEffect(() => {
    if (!scene) return;
    lastScene.current = scene;
    const timer = window.setTimeout(() => setScene(null), scenes[scene]);
    return () => window.clearTimeout(timer);
  }, [scene]);

  // 平时隔一会儿自己玩一段。贴边半隐藏、拖动、AI 处理中都不演。
  useEffect(() => {
    if (still || compact || scene || busy || moving || pose !== 'free' || reducedMotion()) return;
    const delay = firstScene.current ? FIRST_SCENE_DELAY : 9000 + Math.random() * 11000;
    const timer = window.setTimeout(() => {
      firstScene.current = false;
      if (document.hidden) return setScene(null);
      const choices = idleScenes.filter((s) => s !== lastScene.current);
      setScene(choices[Math.floor(Math.random() * choices.length)]);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [still, compact, scene, busy, moving, pose]);

  // 鼠标靠近时眼睛跟着看，走远了又看回对方。
  useEffect(() => {
    if (still || compact || reducedMotion()) return;
    let frame = 0;
    let point: { x: number; y: number } | null = null;
    const apply = () => {
      frame = 0;
      const svg = ref.current;
      if (!svg || !point) return;
      const box = svg.getBoundingClientRect();
      const dx = point.x - (box.left + box.width / 2),
        dy = point.y - (box.top + box.height / 2),
        distance = Math.hypot(dx, dy);
      if (distance > 320 || distance < 1) {
        svg.style.removeProperty('--yl-track-x');
        svg.style.removeProperty('--yl-track-y');
        svg.removeAttribute('data-tracking');
        return;
      }
      // 贴左边时整组是左右翻转的，x 要反过来才看得对。
      const flip = poseRef.current === 'dock-left' ? -1 : 1;
      svg.style.setProperty('--yl-track-x', ((flip * dx) / distance * 1.3).toFixed(2) + 'px');
      svg.style.setProperty('--yl-track-y', ((dy / distance) * 1.3).toFixed(2) + 'px');
      svg.setAttribute('data-tracking', '1');
    };
    const onMove = (event: PointerEvent) => {
      point = { x: event.clientX, y: event.clientY };
      if (!frame) frame = window.requestAnimationFrame(apply);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [still, compact]);

  return (
    <svg
      ref={ref}
      className="yl-duo"
      data-pose={pose}
      data-scene={scene ?? undefined}
      data-busy={busy ? '1' : undefined}
      data-still={still ? '1' : undefined}
      data-compact={compact ? '1' : undefined}
      data-fresh={fresh ? '1' : undefined}
      data-arrive={arrive ?? undefined}
      data-speaker={speaker}
      data-speak={speaker && speakTick ? speaker + '-' + (speakTick % 2) : undefined}
      viewBox="0 0 108 112"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <ellipse className="yl-shadow yl-shadow-y" cx="35" cy="105" rx="24" ry="3" />
      <ellipse className="yl-shadow yl-shadow-l" cx="78" cy="105" rx="27" ry="3" />

      {/* 小甬 */}
      <g className="yl-y-pose">
        <g className="yl-y-enter">
        <g className="yl-y-act">
          <g className="yl-y-breathe">
            <g className="yl-y-body">
              <path d="M24 46H46V98H24Z" />
              <path className="yl-arm-l" d="M4 14H25L35 31V50H24Z" />
              <path className="yl-arm-r" d="M66 14H45L35 31V50H46Z" />
            </g>
            <g className="yl-face yl-face-y">
            <g className="yl-eyes yl-eyes-y">
              <circle className="yl-white" cx="29" cy="55" r="4.4" />
              <circle className="yl-white" cx="41" cy="55" r="4.4" />
              <g className="yl-look">
                <g className="yl-pupils yl-pupils-y">
                  <circle className="yl-pupil" cx="29" cy="55.4" r="2.64" />
                  <circle className="yl-pupil" cx="41" cy="55.4" r="2.64" />
                  <circle className="yl-glint" cx="29.9" cy="54.1" r=".88" />
                  <circle className="yl-glint" cx="41.9" cy="54.1" r=".88" />
                </g>
              </g>
            </g>
            <g className="yl-cheeks">
              <ellipse cx="27" cy="63" rx="3" ry="1.8" />
              <ellipse cx="43" cy="63" rx="3" ry="1.8" />
            </g>
            <path className="yl-smile yl-smile-y" d="M31.4 63Q35 67.3 38.6 63" />
            <path className="yl-open yl-open-y" d="M31 62.4Q35 61.6 39 62.4Q38.6 68.4 35 68.4Q31.4 68.4 31 62.4Z" />
            </g>
          </g>
        </g>
        </g>
      </g>

      {/* 小勒 */}
      <g className="yl-l-pose">
        <g className="yl-l-enter">
        <g className="yl-l-act">
          <g className="yl-l-breathe">
            <path className="yl-l-stem" d="M52 56 73 21V76L52 95Z" />
            <g className="yl-face yl-face-l">
            <g className="yl-eyes yl-eyes-l">
              <circle className="yl-white" cx="57.5" cy="56" r="4.4" />
              <circle className="yl-white" cx="68.5" cy="56" r="4.4" />
              <g className="yl-look">
                <g className="yl-pupils yl-pupils-l">
                  <circle className="yl-pupil" cx="57.5" cy="56.4" r="2.64" />
                  <circle className="yl-pupil" cx="68.5" cy="56.4" r="2.64" />
                  <circle className="yl-glint" cx="58.4" cy="55.1" r=".88" />
                  <circle className="yl-glint" cx="69.4" cy="55.1" r=".88" />
                </g>
              </g>
            </g>
            <g className="yl-cheeks">
              <ellipse cx="55.5" cy="64" rx="3" ry="1.8" />
              <ellipse cx="70.5" cy="64" rx="3" ry="1.8" />
            </g>
            <path className="yl-smile yl-smile-l" d="M59.4 64Q63 68.3 66.6 64" />
            <path className="yl-open yl-open-l" d="M59 63.4Q63 62.6 67 63.4Q66.6 69.4 63 69.4Q59.4 69.4 59 63.4Z" />
            </g>
            {/* 脚和它托着的东西一起动，折痕就是转轴 */}
            <g className="yl-foot">
              <path className="yl-foot-board" d="M77 79H103L93 98H56Z" />
              <g className="yl-cargo">
                <g className="yl-box">
                  <rect className="yl-box-body" x="80" y="58" width="20" height="18" rx="1.6" />
                  <rect className="yl-box-tape" x="87.6" y="58" width="4.8" height="7.6" />
                </g>
                <g className="yl-star">
                  <path d="M90 33.9Q91.2 40.8 98.1 42Q91.2 43.2 90 50.1Q88.8 43.2 81.9 42Q88.8 40.8 90 33.9Z" />
                  <circle cx="99.5" cy="35.7" r="1.5" />
                </g>
              </g>
            </g>
          </g>
        </g>
        </g>
      </g>

      {/* 互动时才出现的效果 */}
      <g className="yl-dots">
        <circle cx="52" cy="14" r="1.8" />
        <circle cx="58" cy="10" r="2.1" />
        <circle cx="65" cy="7" r="2.4" />
      </g>
      <path
        className="yl-heart"
        d="M62 12.5C59.4 10.2 55.5 8.4 55.5 5.1C55.5 2.7 58.9 1.7 62 4.6C65.1 1.7 68.5 2.7 68.5 5.1C68.5 8.4 64.6 10.2 62 12.5Z"
      />
      <g className="yl-burst">
        <path d="M70 7V2M77 10 81 7M63 10 59 7M79 16H84M61 16H56" />
        <circle cx="70" cy="14" r="2.4" />
      </g>
    </svg>
  );
}
