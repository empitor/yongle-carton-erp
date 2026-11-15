import { useSyncExternalStore } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { listen, saveTheme, validTheme, THEME_STORAGE_KEY } from './ui/index';

/** 页面现在套着的外观偏好；别的标签页改了、本页切换，都经 erp-theme-changed 通知到这里。 */
const subscribe = (notify: () => void) => listen('erp-theme-changed', notify);
const currentPreference = () => validTheme(document.documentElement.dataset.themePreference);

export default function ThemeSwitcher() {
  const preference = useSyncExternalStore(subscribe, currentPreference);
  const Icon = preference === 'dark' ? Moon : preference === 'light' ? Sun : Monitor;
  return (
    <label className="theme-switcher" title="切换界面主题，自动保存到本浏览器">
      <Icon size={16} aria-hidden="true" />
      <select
        name={THEME_STORAGE_KEY}
        aria-label="界面主题"
        value={preference}
        onChange={(event) => saveTheme(validTheme(event.target.value))}
      >
        <option value="light">浅色模式</option>
        <option value="dark">深色模式</option>
        <option value="system">跟随系统</option>
      </select>
    </label>
  );
}
