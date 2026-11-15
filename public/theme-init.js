// CSP 允许的本地独立脚本：在样式加载前恢复外观，避免深色偏好下刷新时闪白。之后的切换和跨标签页同步在 src/ui/theme.ts。
(() => {
  let preference = 'system';
  try {
    const saved = localStorage.getItem('zhixu-erp.theme');
    if (saved === 'light' || saved === 'dark') preference = saved;
  } catch {
    /* 存储不可用时跟随系统。 */
  }
  const dark =
    preference === 'dark' ||
    (preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#141c24' : '#f3f6f7');
})();
