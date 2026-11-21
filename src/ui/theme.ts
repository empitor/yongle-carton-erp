import { emit } from './events';

export const THEME_STORAGE_KEY = 'zhixu-erp.theme';
export type ThemePreference = 'light' | 'dark' | 'system';
/** 系统是不是深色 */
const DARK_QUERY = '(prefers-color-scheme: dark)';
export function validTheme(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}
export function resolveTheme(preference: ThemePreference, systemDark: boolean) {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
}
export function readTheme(storage: Pick<Storage, 'getItem'>): ThemePreference {
  try {
    return validTheme(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}
function applyTheme(preference: ThemePreference) {
  const resolved = resolveTheme(
    preference,
    window.matchMedia(DARK_QUERY).matches,
  );
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = resolved;
  // 手机浏览器地址栏的颜色跟页面底色走，颜色只在 tokens.css 定义一处
  const pageBg = window.getComputedStyle(document.documentElement).getPropertyValue('--page-bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', pageBg);
  emit('erp-theme-changed');
}
/**
 * 跟随系统时，系统换了深浅页面马上跟着换；别的标签页改了主题偏好，这里也马上跟着换（不管主题菜单开没开）。
 * 页面打开时挂一次（main.tsx），返回停止的函数。
 */
export function followSystemTheme(): () => void {
  const media = window.matchMedia(DARK_QUERY);
  const update = () => {
    if (validTheme(document.documentElement.dataset.themePreference) === 'system') applyTheme('system');
  };
  const storage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) loadTheme();
  };
  media.addEventListener('change', update);
  window.addEventListener('storage', storage);
  return () => {
    media.removeEventListener('change', update);
    window.removeEventListener('storage', storage);
  };
}
export function loadTheme() {
  let preference: ThemePreference = 'system';
  try {
    preference = readTheme(window.localStorage);
  } catch {
    /* 浏览器禁用存储时仍可切换。 */
  }
  applyTheme(preference);
  return preference;
}
export function saveTheme(preference: ThemePreference) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* 当前页面仍可使用。 */
  }
  applyTheme(preference);
}
