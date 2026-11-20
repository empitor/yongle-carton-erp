// 下载用的文件名带上地址里的 ?run= 编号，测试按编号找文件，不会和别的文件混在一起
const run = new URLSearchParams(location.search).get('run') || 'manual';
document.getElementById('http-download').href = '/download?run=' + encodeURIComponent(run);
// 新窗口里打开的下载：编号后面加 popup，和上面那个分开
document.getElementById('popup-download').href = '/download?run=' + encodeURIComponent(run + 'popup');

// 和网页常见的导出写法一样：在页面里生成文件内容，做成 blob: 地址，用 a.download 交给浏览器保存
document.getElementById('blob').addEventListener('click', () => {
  const blob = new Blob(['YONGLE-SHELL-BLOB-TEST\n'], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'yongle-shell-blob-' + run + '.txt';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  document.getElementById('status').textContent = '已发起 blob 下载';
});

// 照 ERP 导出订货单、送货单的写法（ERP 的 src/ui/save-file.ts）：文件内容到手后做成 blob: 地址，
// a.download 带中文文件名，a 不放进页面直接 click，一分钟后释放地址。导出按钮点下去先等一会儿，像等服务器
window.exportFile = (name) => {
  const bytes = new TextEncoder().encode('YONGLE-SHELL-EXPORT-TEST\n');
  const type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
};
document.getElementById('export').addEventListener('click', async () => {
  await new Promise((done) => setTimeout(done, 1000));
  window.exportFile('送货单-yongle-shell-' + run + '.xlsx');
});
