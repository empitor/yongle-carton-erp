import type { IncomingMessage, ServerResponse } from 'node:http';

/*
 * 服务器一边办一边往浏览器写（助手回复、识别进度、朗读音频）只有这一份写法；浏览器的读法在 src/ui/event-stream.ts。
 * 事件流（text/event-stream）一条事件写成 `event: 名字`、`data: JSON`、空行；心跳写一行 `: heartbeat` 注释，
 * 读的一方跳过注释行，它只为让 nginx 这类代理别把一阵没动静的连接掐断。
 */

/** 心跳间隔：nginx 默认 60 秒没数据就断开，10 秒一次留足余量，又不多占流量 */
export const STREAM_HEARTBEAT_MS = 10_000;
/** 只算最新一条的事件（进度、整段替换的正文）同一段里最多多久写一次：一秒四次，页面看着连贯，也不白白重画 */
export const STREAM_LATEST_MS = 250;

/** 连接在回完之前断了（页面关掉、点了停止、网断）调一次 onLost；返回的函数表示回完了，之后再断不算 */
export function watchDisconnect(res: ServerResponse, onLost: () => void): () => void {
  const release = () => void res.off('close', lost);
  const lost = () => {
    release();
    onLost();
  };
  res.on('close', lost);
  return release;
}

/** D 是用 send 写的事件的数据（只算最新一条的事件按它算归哪一段），收尾 end 写的不算 */
export type EventStreamOptions<D> = {
  /** 请求和响应的空闲超时 */
  timeoutMs: number;
  /** 回完之前连接断了：停掉还在办的事 */
  onLost?: () => void;
  /**
   * 只算最新一条的事件：名字 → 这条归哪一段（比如进度的阶段）。同一段里离上次不到 STREAM_LATEST_MS 的先攒着、
   * 新的替掉旧的，到点写出；换了段、要写别的事件、收尾时先把攒着的写出去，所以顺序不乱、每一段的最后一条不丢。
   */
  latest?: Record<string, (data: D) => unknown>;
};

export type EventStream<D> = {
  /** 写一条事件 */
  send: (event: string, data: D) => void;
  /** 写最后一条事件（result 或 error）并结束响应 */
  end: (event: string, data: unknown) => void;
};

/** 开一条事件流：发响应头、开始心跳、盯着连接断开 */
export function openEventStream<D = unknown>(
  req: IncomingMessage,
  res: ServerResponse,
  options: EventStreamOptions<D>,
): EventStream<D> {
  req.setTimeout(options.timeoutMs);
  res.setTimeout(options.timeoutMs);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const open = () => !res.destroyed && !res.writableEnded;
  const write = (text: string) => void (open() && res.write(text));
  const writeEvent = (event: string, data: unknown) =>
    write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  const release = options.onLost ? watchDisconnect(res, options.onLost) : () => {};
  const heartbeat = setInterval(() => write(': heartbeat\n\n'), STREAM_HEARTBEAT_MS);
  heartbeat.unref();
  const latest = latestWriter(writeEvent, options.latest ?? {});
  return {
    send: latest.send,
    end(event, data) {
      release();
      clearInterval(heartbeat);
      latest.flush();
      writeEvent(event, data);
      if (open()) res.end();
    },
  };
}

/** 只算最新一条的那几种事件怎么节流（见 EventStreamOptions.latest） */
function latestWriter<D>(
  writeEvent: (event: string, data: unknown) => void,
  parts: Record<string, (data: D) => unknown>,
) {
  const last = new Map<string, { at: number; part: unknown }>();
  let held: { event: string; data: D; part: unknown } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const put = (event: string, data: D, part: unknown) => {
    writeEvent(event, data);
    last.set(event, { at: Date.now(), part });
  };
  const drop = () => {
    if (timer) clearTimeout(timer);
    timer = held = null;
  };
  const flush = () => {
    const h = held;
    drop();
    if (h) put(h.event, h.data, h.part);
  };
  const send = (event: string, data: D) => {
    const partOf = parts[event];
    const part = partOf?.(data);
    // 攒着的不是同一种、同一段：先写出去，保证顺序
    if (held && (!partOf || held.event !== event || held.part !== part)) flush();
    if (!partOf) return writeEvent(event, data);
    const prev = last.get(event);
    if (prev && prev.part === part && Date.now() - prev.at < STREAM_LATEST_MS) {
      held = { event, data, part };
      timer ??= setTimeout(flush, prev.at + STREAM_LATEST_MS - Date.now());
      timer.unref();
      return;
    }
    // 攒着的（如果有）是同一段更旧的，这条替掉它
    drop();
    put(event, data, part);
  };
  return { send, flush };
}

/** 等写缓冲腾出来，或者连接断了、被取消了 */
const drained = (res: ServerResponse, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      signal.removeEventListener('abort', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
    signal.addEventListener('abort', done);
  });

/**
 * 把上游的字节流边收边写给浏览器（朗读的音频）。第一块到了才发响应头（headers）：之前出错原样抛出，
 * 由出错处理回中文说明；写缓冲满了等它腾出来；signal 取消了（浏览器断开、被顶掉）就停读上游、断开连接；
 * 已经开始写以后上游出错，先让写出的那块送到再断开，浏览器才分得清“读了一半断了”。
 */
export async function pipeBytes(
  res: ServerResponse,
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  headers: Record<string, string>,
): Promise<void> {
  const begin = () => {
    res.statusCode = 200;
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  };
  const reader = body.getReader();
  // 最近一块写到连接上了没有
  let written: Promise<void> = Promise.resolve();
  // 取消时正在等的那次读取立刻结束
  const stopReading = () => void reader.cancel().catch(() => {});
  signal.addEventListener('abort', stopReading);
  try {
    for (;;) {
      if (signal.aborted) throw new Error('cancelled');
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error('cancelled');
      if (done) break;
      if (!res.headersSent) begin();
      let flushed!: () => void;
      written = new Promise((resolve) => (flushed = resolve));
      if (!res.write(value, () => flushed())) await drained(res, signal);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (!res.headersSent && !signal.aborted) throw error;
    if (!signal.aborted) await written;
    res.destroy();
    return;
  } finally {
    signal.removeEventListener('abort', stopReading);
  }
  if (!res.headersSent) begin();
  res.end();
}
