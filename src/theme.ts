export const THEME_STORAGE_KEY = 'zhixu-erp.theme';
export type ThemePreference = 'light' | 'dark' | 'system';
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
export function applyTheme(preference: ThemePreference) {
  const resolved = resolveTheme(
    preference,
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', resolved === 'dark' ? '#141c24' : '#f3f6f7');
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
