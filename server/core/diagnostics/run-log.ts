import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIB } from '../../../shared/core/index.js';
import type { Actor } from '../actor.js';
import { isoTime, pageWindow, requireSuperAdmin, type PageSize } from './reading.js';
import { clip, redactSecrets } from './redact.js';

/**
 * 运行日志：程序自己把输出（console 写到标准输出、标准错误的）另存一份能读回来的，不靠命令行看系统日志。
 * 每行前面加时间和来源（O 是输出，E 是错误），写入前打码；文件超过上限就换成 .1，只留这两份（最近约 2×上限）。
 */

const DEFAULT_MAX_BYTES = 2 * MIB;
/** 一行最多记几个字 */
const LINE_MAX_CHARS = 2000;
/** 看最近几行：默认 200，最多 1000；搜索给几行：默认 100，最多 500 */
const TAIL_PAGE: PageSize = { size: 200, max: 1000 },
  SEARCH_PAGE: PageSize = { size: 100, max: 500 };
type WriteCallback = (error?: Error | null) => void;
const LINE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) ([OE]) (.*)$/;

export type RunLogLine = { time: string; stream: '输出' | '错误'; text: string };

export class RunLog {
  private size: number;
  constructor(
    readonly file: string,
    private maxBytes = DEFAULT_MAX_BYTES,
    private now: () => number = Date.now,
  ) {
    mkdirSync(dirname(file), { recursive: true });
    this.size = existsSync(file) ? statSync(file).size : 0;
  }

  /** 记一段输出（可以是多行）。写不进去时静默放弃：日志不能拖垮程序，也不能再往输出里写（会绕回来） */
  append(chunk: string, stream: 'out' | 'err') {
    try {
      const at = new Date(this.now()).toISOString(),
        mark = stream === 'err' ? 'E' : 'O';
      const lines = chunk
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => `${at} ${mark} ${clip(redactSecrets(l), LINE_MAX_CHARS)}\n`)
        .join('');
      if (!lines) return;
      const bytes = Buffer.byteLength(lines);
      if (this.size + bytes > this.maxBytes && this.size > 0) {
        rmSync(this.file + '.1', { force: true });
        renameSync(this.file, this.file + '.1');
        this.size = 0;
      }
      appendFileSync(this.file, lines);
      this.size += bytes;
    } catch {
      /* 见上 */
    }
  }

  /** 两份文件里的全部行，从旧到新 */
  lines(): RunLogLine[] {
    const out: RunLogLine[] = [];
    for (const file of [this.file + '.1', this.file]) {
      if (!existsSync(file)) continue;
      for (const raw of readFileSync(file, 'utf8').split('\n')) {
        const m = LINE.exec(raw);
        if (m) out.push({ time: m[1], stream: m[2] === 'E' ? '错误' : '输出', text: m[3] });
      }
    }
    return out;
  }
}

/**
 * 把进程的标准输出、标准错误同时抄一份进运行日志（原来的输出照旧）。返回撤销函数。
 * 装配时调一次（server/index.ts）；测试里用完要撤销。
 */
export function captureProcessOutput(log: RunLog): () => void {
  const tap = (stream: NodeJS.WriteStream, kind: 'out' | 'err') => {
    const original = stream.write;
    const write = original.bind(stream);
    stream.write = (chunk: Uint8Array | string, encoding?: BufferEncoding | WriteCallback, callback?: WriteCallback) => {
      log.append(typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '', kind);
      return typeof encoding === 'function' ? write(chunk, encoding) : write(chunk, encoding, callback);
    };
    return () => {
      stream.write = original;
    };
  };
  const undo = [tap(process.stdout, 'out'), tap(process.stderr, 'err')];
  return () => undo.forEach((u) => u());
}

/** 看最近 N 行运行日志（默认 200，最多 1000）。只给超级管理员 */
export function readRunLog(log: RunLog, actor: Actor | null | undefined, input: { lines?: number } = {}) {
  requireSuperAdmin(actor, '运行日志');
  const count = pageWindow(input.lines, 0, TAIL_PAGE).limit;
  const all = log.lines();
  return { total: all.length, lines: all.slice(-count) };
}

/**
 * 按文字（不分大小写）和时间段找运行日志，给最近的 limit 行（默认 100，最多 500）。只给超级管理员
 */
export function searchRunLog(
  log: RunLog,
  actor: Actor | null | undefined,
  input: { text?: string; from?: string; to?: string; limit?: number } = {},
) {
  requireSuperAdmin(actor, '运行日志');
  const text = input.text?.trim().toLowerCase(),
    from = input.from ? isoTime(input.from, '开始') : undefined,
    to = input.to ? isoTime(input.to, '结束') : undefined,
    limit = pageWindow(input.limit, 0, SEARCH_PAGE).limit;
  const found = log
    .lines()
    .filter((l) => (!text || l.text.toLowerCase().includes(text)) && (!from || l.time >= from) && (!to || l.time <= to));
  return { total: found.length, more: found.length > limit, lines: found.slice(-limit) };
}
