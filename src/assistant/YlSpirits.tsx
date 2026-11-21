import { useEffect, useRef, useState, type RefObject } from 'react';
import type { FloatingDock } from './floating-assistant';
import type { AssistantSpeaker } from '../../shared/assistant/index';
import { LeFigure, SceneEffects, YongFigure } from './yl-figures';
import { prefersReducedMotion } from '../ui/index';

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
const isScene = (name: string): name is Scene => name in scenes;
const idleScenes = Object.keys(scenes).filter(isScene);
const FIRST_SCENE_DELAY = 6000;

/** 聊天消息前的小头像：只画头和脸，不动。 */
export function SpeakerAvatar({ speaker }: { speaker: AssistantSpeaker }) {
  return speaker === 'yong' ? (
    <svg className="yl-avatar" viewBox="0 8 70 66" aria-hidden="true" focusable="false">
      <path fill="var(--teal)" d="M4 14H25L35 31 45 14H66L46 50V74H24V50Z" />
      <circle className="yl-white" cx="29" cy="55" r="4.4" />
      <circle className="yl-white" cx="41" cy="55" r="4.4" />
      <circle className="yl-pupil" cx="29.9" cy="55.4" r="2.64" />
      <circle className="yl-pupil" cx="41.9" cy="55.4" r="2.64" />
    </svg>
  ) : (
    <svg className="yl-avatar" viewBox="30 16 66 66" aria-hidden="true" focusable="false">
      <path fill="var(--kraft)" d="M50 56 73 19V82H50Z" />
      <circle className="yl-white" cx="57.5" cy="56" r="4.4" />
      <circle className="yl-white" cx="68.5" cy="56" r="4.4" />
      <circle className="yl-pupil" cx="56.6" cy="56.4" r="2.64" />
      <circle className="yl-pupil" cx="67.6" cy="56.4" r="2.64" />
    </svg>
  );
}

/** 鼠标靠近时眼睛跟着看，走远了又看回对方（enabled：still、compact 时不跟） */
function useEyeTracking(
  ref: RefObject<SVGSVGElement | null>,
  poseRef: RefObject<FloatingDock>,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled || prefersReducedMotion()) return;
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
  }, [enabled, ref, poseRef]);
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
    if (wasBusy.current && !busy && !still && !compact && !prefersReducedMotion()) setScene('highfive');
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
    if (still || compact || scene || busy || moving || pose !== 'free' || prefersReducedMotion()) return;
    const delay = firstScene.current ? FIRST_SCENE_DELAY : 9000 + Math.random() * 11000;
    const timer = window.setTimeout(() => {
      firstScene.current = false;
      if (document.hidden) return setScene(null);
      const choices = idleScenes.filter((s) => s !== lastScene.current);
      setScene(choices[Math.floor(Math.random() * choices.length)]);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [still, compact, scene, busy, moving, pose]);

  useEyeTracking(ref, poseRef, !still && !compact);

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
      <YongFigure />

      {/* 小勒 */}
      <LeFigure />

      {/* 互动时才出现的效果 */}
      <SceneEffects />
    </svg>
  );
}
