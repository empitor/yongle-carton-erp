import { useEffect, useState } from 'react';

// 是不是手机宽度：页面按它换成手机排布。各模块都用，放在基础组件里。
const PHONE_QUERY = '(max-width: 700px)';

/** 非渲染场景（服务端渲染、测试）下按电脑处理。 */
export function isPhoneNow() {
  return typeof window !== 'undefined' && !!window.matchMedia?.(PHONE_QUERY).matches;
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
