import { useEffect, useState } from 'react';

// 设备上的两件事，各模块都用，放在基础组件里：是不是手机宽度（页面按它换成手机排布）；系统要不要减少动态效果。
const PHONE_QUERY = '(max-width: 700px)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** 非渲染场景（服务端渲染、测试）下按电脑处理。 */
export function isPhoneNow() {
  return typeof window !== 'undefined' && !!window.matchMedia?.(PHONE_QUERY).matches;
}

/** 系统开了“减少动态效果”（安卓的“移除动画”这类）：动画、回弹都不做。非渲染场景按没开处理 */
export function prefersReducedMotion() {
  return typeof window !== 'undefined' && !!window.matchMedia?.(REDUCED_MOTION_QUERY).matches;
}

export function useIsPhone() {
  const [phone, setPhone] = useState(isPhoneNow);
  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia(PHONE_QUERY);
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return phone;
}
