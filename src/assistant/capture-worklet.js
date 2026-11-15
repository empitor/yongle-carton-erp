// 录音的音频线程（AudioWorklet 处理器，由 capture-graph.ts 用 new URL(…, import.meta.url) 加载）：
// 麦克风的每一小块样本（单声道，浏览器每次 128 个）原样交给页面，页面那边攒起来、数到上限就停。
// 只读不改声音，不往外输出（输出保持静音）。这个文件在音频线程里单独运行，不能引用别的模块，
// 处理器的名字 'erp-capture' 和 capture-graph.ts 的 CAPTURE_PROCESSOR 要一致。
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel?.length) {
      const copy = new Float32Array(channel);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor('erp-capture', CaptureProcessor);
