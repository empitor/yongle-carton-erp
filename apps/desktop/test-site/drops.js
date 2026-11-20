// 拖放：页内拖动卡片、从外面拖文件进来，放到接收区后记进 window.drops（“text:card”“file:文件名”）。
// 外壳关掉 Tauri 自己的拖放接管后，网页才收得到这些 HTML5 拖放事件
window.drops = [];
/** 经过接收区的拖动事件（排查用：拖进来了没有、带的是什么类型） */
window.dragEvents = [];
const zone = document.getElementById('dropzone');
for (const type of ['dragenter', 'dragover', 'drop']) {
  zone.addEventListener(type, (event) => {
    const entry = type + ':' + [...event.dataTransfer.types].join('+');
    if (window.dragEvents.at(-1) !== entry) window.dragEvents.push(entry);
  });
}
document.getElementById('card').addEventListener('dragstart', (event) => {
  event.dataTransfer.setData('text/plain', 'card');
});
zone.addEventListener('dragover', (event) => event.preventDefault());
zone.addEventListener('drop', (event) => {
  event.preventDefault();
  const files = [...event.dataTransfer.files].map((file) => file.name);
  const drop = files.length > 0 ? 'file:' + files.join(',') : 'text:' + event.dataTransfer.getData('text/plain');
  window.drops.push(drop);
  zone.textContent = '收到 ' + drop;
});
