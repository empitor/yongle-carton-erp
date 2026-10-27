// Project-owned minimal types for installed sherpa-onnx-node 1.13.8; not vendor code.
declare module 'sherpa-onnx-node' {
  export type Waveform = { samples: Float32Array; sampleRate: number };
  export type OfflineRecognizerConfig = {
    featConfig: { sampleRate: number; featureDim: number };
    modelConfig: {
      senseVoice: { model: string; language: string; useInverseTextNormalization: number };
      tokens: string;
      numThreads: number;
      provider: string;
      debug: number;
    };
  };
  export class OfflineStream {
    acceptWaveform(waveform: Waveform): void;
  }
  export class OfflineRecognizer {
    constructor(config: OfflineRecognizerConfig);
    createStream(): OfflineStream;
    decode(stream: OfflineStream): void;
    getResult(stream: OfflineStream): { text?: string };
  }
  export function readWave(path: string): Waveform;
  export const Vad: unknown;
  const api: {
    OfflineRecognizer: typeof OfflineRecognizer;
    readWave: typeof readWave;
    Vad: unknown;
  };
  export default api;
}
