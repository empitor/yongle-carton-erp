// Local-only manual acceptance; use synthetic/explicitly authorized WAV input.
import sherpa from 'sherpa-onnx-node';
import { performance } from 'node:perf_hooks';
import { getSpeechEngine } from '../../server/speech/engine.js';
import { SPEECH_SAMPLE_RATE } from '../../shared/speech.js';
const path = process.argv[2];
if (!path) {
  console.error('用法：node scripts/speech-smoke.cjs <16kHz 单声道 WAV>');
  process.exitCode = 2;
} else {
  const wave = sherpa.readWave(path);
  if (wave.sampleRate !== SPEECH_SAMPLE_RATE) throw Error('自检要求16kHz单声道WAV。');
  const started = performance.now(),
    engine = await getSpeechEngine();
  console.log('model loaded in', Math.round(performance.now() - started), 'ms');
  for (let i = 1; i <= 3; i++) {
    const next = await getSpeechEngine();
    if (next !== engine) throw Error('识别引擎未复用');
    const begin = performance.now(),
      text = await engine.transcribe(wave.samples);
    console.log(
      JSON.stringify({
        attempt: i,
        modelReused: true,
        decodeMs: Math.round(performance.now() - begin),
        text,
      }),
    );
  }
}
