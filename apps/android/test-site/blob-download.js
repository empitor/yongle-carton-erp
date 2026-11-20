// 和网页常见的导出写法一样：在页面里生成文件内容，做成 blob: 地址，用 a.download 交给浏览器保存
document.getElementById('blob').addEventListener('click', () => {
  const blob = new Blob(['YONGLE-SHELL-BLOB-TEST\n'], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'yongle-blob-test.txt';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  document.getElementById('status').textContent = '已发起 blob 下载';
});
