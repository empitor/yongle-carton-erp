import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImportError } from '../import/errors.js';
import { SPEECH_SAMPLE_RATE } from '../../shared/speech.js';
export type SpeechEngine = { transcribe: (samples: Float32Array) => Promise<string> | string };
export const speechModelDirectory = fileURLToPath(
  new URL('../../vendor/models/sensevoice/', import.meta.url),
);
let enginePromise: Promise<SpeechEngine> | null = null;
let testEngine: SpeechEngine | null = null;
async function loadEngine(): Promise<SpeechEngine> {
  const model = join(speechModelDirectory, 'model.int8.onnx'),
    tokens = join(speechModelDirectory, 'tokens.txt');
  if (!existsSync(model) || !existsSync(tokens))
    throw new ImportError(
      '本地语音模型文件缺失，请检查 vendor/models/sensevoice 是否完整。',
      503,
      'speech-model',
    );
  const loaded = await import('sherpa-onnx-node');
  const api = loaded.OfflineRecognizer ? loaded : loaded.default;
  if (!api?.OfflineRecognizer)
    throw new ImportError('本地语音引擎不可用：未找到 sherpa-onnx-node。', 503, 'speech-engine');
  // Preserve the accepted model, CPU provider, two threads, language and ITN.
  const recognizer = new api.OfflineRecognizer({
    featConfig: { sampleRate: SPEECH_SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: { model, language: 'auto', useInverseTextNormalization: 1 },
      tokens,
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
    },
  });
  return {
    transcribe(samples) {
      // Native streams are finalized by the addon; it exposes no dispose/free API.
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples, sampleRate: SPEECH_SAMPLE_RATE });
      recognizer.decode(stream);
      return String(recognizer.getResult(stream)?.text ?? '');
    },
  };
}
export async function getSpeechEngine(): Promise<SpeechEngine> {
  if (testEngine) return testEngine;
  if (!enginePromise)
    enginePromise = loadEngine().catch((error) => {
      enginePromise = null;
      throw error;
    });
  return enginePromise;
}
/** Test injection only; production imports never call this. The real cache is not reset. */
export function setSpeechEngineForTests(engine: SpeechEngine | null) {
  testEngine = engine;
}
