import { useSlots, type FileSaver } from './slots';

/*
 * 把内存里的文件（导出的订货单、送货单，单据模板的测试样张）交到用户手里，存好了才算完。
 * 浏览器和 Windows 外壳里交给浏览器下载（a.download）；安卓 App 的 WebView 存不了这种文件，
 * 由装配（src/main.tsx）在 App 里往插槽 saveFile 填“交给 App 保存”（src/app-save.ts，走通道、等 App 回话）。
 */

/** 临时下载地址留多久（毫秒） */
const OBJECT_URL_LIFETIME_MS = 60000;

/** 交给浏览器下载；临时地址一分钟后释放 */
const browserSave: FileSaver = (bytes, type, filename) => {
  const url = URL.createObjectURL(new Blob([bytes], { type })),
    a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_LIFETIME_MS);
  return Promise.resolve();
};

/** 保存文件的做法：装配填了（安卓 App 里）就用它，没填交给浏览器下载 */
export function useSaveFile(): FileSaver {
  return useSlots().saveFile ?? browserSave;
}
