/** Preserve linear resampling and quantization; encode PCM explicitly little-endian. */
export function mergeAudioChunks(chunks: Float32Array[]): Float32Array {
  const merged = new Float32Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return merged;
}
export function resampleAudio(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || !input.length) return input;
  const ratio = from / to,
    length = Math.max(1, Math.round(input.length / ratio)),
    output = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const position = i * ratio,
      left = Math.floor(position),
      right = Math.min(left + 1, input.length - 1),
      weight = position - left;
    output[i] = input[left] * (1 - weight) + input[right] * weight;
  }
  return output;
}
export function encodePcm16LE(samples: Float32Array): ArrayBuffer {
  const result = new ArrayBuffer(samples.length * 2),
    view = new DataView(result);
  for (let i = 0; i < samples.length; i++) {
    const value = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0;
    view.setInt16(i * 2, value < 0 ? Math.round(value * 32768) : Math.round(value * 32767), true);
  }
  return result;
}
