/**
 * 飞书长连接的帧：protobuf 的 pbbp2.Frame / Header，只有这 9 个字段，手写编解码，不引 protobuf 库。
 * 飞书没有公开这套协议，字段编号和类型照官方 Node SDK（@larksuiteoapi/node-sdk 1.76.0，MIT）的
 * ws-client/proto-buf/pbbp2.js；数据帧可能拆成几片（headers 里的 sum、seq），按 message_id 拼回来。
 */

export const FRAME_CONTROL = 0;
export const FRAME_DATA = 1;

export type FeishuHeader = { key: string; value: string };
export type FeishuFrame = {
  SeqID: bigint;
  LogID: bigint;
  service: number;
  method: number;
  headers: FeishuHeader[];
  payloadEncoding?: string;
  payloadType?: string;
  payload?: Uint8Array;
  LogIDNew?: string;
};

/** Frame、Header 的字段编号（pbbp2.proto） */
const frameField = {
  SeqID: 1,
  LogID: 2,
  service: 3,
  method: 4,
  headers: 5,
  payloadEncoding: 6,
  payloadType: 7,
  payload: 8,
  LogIDNew: 9,
} as const;
const headerField = { key: 1, value: 2 } as const;
/** protobuf 的线上类型：变长整数、8 字节定长、长度定界、4 字节定长 */
const wireType = { varint: 0, fixed64: 1, bytes: 2, fixed32: 5 } as const;
const fixedBytes = { fixed64: 8, fixed32: 4 } as const;
/** 标签 = 字段编号 << 3 | 线上类型 */
const TAG_SHIFT = 3;
const WIRE_MASK = 7;
/** 变长整数：每字节 7 位数据，最高位表示后面还有 */
const VARINT_BITS = 7n;
const VARINT_DATA = 0x7f;
const VARINT_MORE = 0x80;
/** 变长整数最多 64 位：移位超过 63 就不是合法的帧 */
const UINT64_BITS = 64;
const MAX_SHIFT = 63n;
/** service、method 是 int32 */
const INT32_BITS = 32;
const FRAME_INVALID = '飞书帧格式不对';

const utf8 = new TextEncoder(),
  text = new TextDecoder();

function varint(value: bigint) {
  const out: number[] = [];
  let v = BigInt.asUintN(UINT64_BITS, value);
  do {
    let byte = Number(v & BigInt(VARINT_DATA));
    v >>= VARINT_BITS;
    if (v) byte |= VARINT_MORE;
    out.push(byte);
  } while (v);
  return out;
}
function bytesField(field: number, bytes: Uint8Array) {
  return [...varint(BigInt((field << TAG_SHIFT) | wireType.bytes)), ...varint(BigInt(bytes.length)), ...bytes];
}
function varintField(field: number, value: bigint) {
  return [...varint(BigInt(field << TAG_SHIFT)), ...varint(value)];
}
function headerBytes(h: FeishuHeader) {
  return Uint8Array.from([...bytesField(headerField.key, utf8.encode(h.key)), ...bytesField(headerField.value, utf8.encode(h.value))]);
}

export function encodeFrame(frame: FeishuFrame) {
  const out = [
    ...varintField(frameField.SeqID, frame.SeqID),
    ...varintField(frameField.LogID, frame.LogID),
    ...varintField(frameField.service, BigInt(frame.service)),
    ...varintField(frameField.method, BigInt(frame.method)),
  ];
  for (const h of frame.headers) out.push(...bytesField(frameField.headers, headerBytes(h)));
  if (frame.payloadEncoding !== undefined) out.push(...bytesField(frameField.payloadEncoding, utf8.encode(frame.payloadEncoding)));
  if (frame.payloadType !== undefined) out.push(...bytesField(frameField.payloadType, utf8.encode(frame.payloadType)));
  if (frame.payload !== undefined) out.push(...bytesField(frameField.payload, frame.payload));
  if (frame.LogIDNew !== undefined) out.push(...bytesField(frameField.LogIDNew, utf8.encode(frame.LogIDNew)));
  return Uint8Array.from(out);
}

/** 逐个读出字段：编号、类型、值（变长整数是 bigint，长度定界的是字节）。 */
function* fields(bytes: Uint8Array) {
  let at = 0;
  const readVarint = () => {
    let result = 0n,
      shift = 0n;
    for (;;) {
      if (at >= bytes.length || shift > MAX_SHIFT) throw new Error(FRAME_INVALID);
      const byte = bytes[at++];
      result |= BigInt(byte & VARINT_DATA) << shift;
      if (!(byte & VARINT_MORE)) return result;
      shift += VARINT_BITS;
    }
  };
  while (at < bytes.length) {
    const tag = Number(readVarint()),
      field = tag >>> TAG_SHIFT,
      wire = tag & WIRE_MASK;
    if (wire === wireType.varint) yield { field, value: readVarint() };
    else if (wire === wireType.bytes) {
      const length = Number(readVarint());
      if (at + length > bytes.length) throw new Error(FRAME_INVALID);
      yield { field, value: bytes.subarray(at, (at += length)) };
    } else if (wire === wireType.fixed64) at += fixedBytes.fixed64;
    else if (wire === wireType.fixed32) at += fixedBytes.fixed32;
    else throw new Error(FRAME_INVALID);
  }
}

function decodeHeader(bytes: Uint8Array): FeishuHeader {
  const header = { key: '', value: '' };
  for (const part of fields(bytes))
    if (part.value instanceof Uint8Array && (part.field === headerField.key || part.field === headerField.value))
      header[part.field === headerField.key ? 'key' : 'value'] = text.decode(part.value);
  return header;
}
function setNumber(frame: FeishuFrame, field: number, value: bigint) {
  if (field === frameField.SeqID) frame.SeqID = value;
  else if (field === frameField.LogID) frame.LogID = value;
  else if (field === frameField.service) frame.service = Number(BigInt.asIntN(INT32_BITS, value));
  else if (field === frameField.method) frame.method = Number(BigInt.asIntN(INT32_BITS, value));
}
function setBytes(frame: FeishuFrame, field: number, value: Uint8Array) {
  if (field === frameField.headers) frame.headers.push(decodeHeader(value));
  else if (field === frameField.payloadEncoding) frame.payloadEncoding = text.decode(value);
  else if (field === frameField.payloadType) frame.payloadType = text.decode(value);
  else if (field === frameField.payload) frame.payload = value;
  else if (field === frameField.LogIDNew) frame.LogIDNew = text.decode(value);
}

export function decodeFrame(bytes: Uint8Array): FeishuFrame {
  const frame: FeishuFrame = { SeqID: 0n, LogID: 0n, service: 0, method: 0, headers: [] };
  for (const { field, value } of fields(bytes)) {
    if (typeof value === 'bigint') setNumber(frame, field, value);
    else setBytes(frame, field, value);
  }
  return frame;
}

export function headerOf(frame: FeishuFrame, key: string) {
  return frame.headers.find((h) => h.key === key)?.value;
}

const FRAGMENT_TTL_MS = 10_000;

/** 分片拼接：收齐一条消息的所有片就返回整段，没收齐返回 null；10 秒没收齐的丢掉（和官方 SDK 一样）。 */
export class FragmentCache {
  private pending = new Map<string, { parts: (Uint8Array | undefined)[]; at: number }>();
  constructor(private now: () => number = Date.now) {}
  merge(messageId: string, sum: number, seq: number, data: Uint8Array) {
    const now = this.now();
    for (const [id, entry] of this.pending) if (now - entry.at > FRAGMENT_TTL_MS) this.pending.delete(id);
    if (!Number.isInteger(sum) || sum < 1 || !Number.isInteger(seq) || seq < 0 || seq >= sum)
      throw new Error('飞书分片编号不对');
    if (sum === 1) return data;
    let entry = this.pending.get(messageId);
    if (!entry || entry.parts.length !== sum) {
      entry = { parts: Array.from({ length: sum }, (): Uint8Array | undefined => undefined), at: now };
      this.pending.set(messageId, entry);
    }
    entry.parts[seq] = data;
    const parts = entry.parts.filter((p) => p !== undefined);
    if (parts.length < sum) return null;
    this.pending.delete(messageId);
    return Buffer.concat(parts);
  }
}
