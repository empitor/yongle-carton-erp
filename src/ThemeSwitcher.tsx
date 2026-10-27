import { useEffect, useState } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import {
  applyTheme,
  loadTheme,
  saveTheme,
  validTheme,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from './theme';
export default function ThemeSwitcher() {
  const [preference, setPreference] = useState<ThemePreference>(() =>
    validTheme(document.documentElement.dataset.themePreference),
  );
  useEffect(() => {
    setPreference(loadTheme());
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      const selected = validTheme(document.documentElement.dataset.themePreference);
      if (selected === 'system') applyTheme(selected);
    };
    const storage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) {
        const selected = loadTheme();
        setPreference(selected);
      }
    };
    media.addEventListener('change', update);
    window.addEventListener('storage', storage);
    return () => {
      media.removeEventListener('change', update);
      window.removeEventListener('storage', storage);
    };
  }, []);
  const Icon = preference === 'dark' ? Moon : preference === 'light' ? Sun : Monitor;
  return (
    <label className="theme-switcher" title="切换界面主题，自动保存到本浏览器">
      <Icon size={16} aria-hidden="true" />
      <select
        aria-label="界面主题"
        value={preference}
        onChange={(event) => {
          const selected = validTheme(event.target.value);
          setPreference(selected);
          saveTheme(selected);
        }}
      >
        <option value="light">浅色模式</option>
        <option value="dark">深色模式</option>
        <option value="system">跟随系统</option>
      </select>
    </label>
  );
}
