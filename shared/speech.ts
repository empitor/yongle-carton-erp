/** Local speech transport contract. Neither models nor credentials belong in the browser. */
export const SPEECH_SAMPLE_RATE = 16000;
export const SPEECH_MAX_SECONDS = 60;
export const SPEECH_MIN_SECONDS = 0.3;
export const SPEECH_MAX_SAMPLES = SPEECH_SAMPLE_RATE * SPEECH_MAX_SECONDS;
export const SPEECH_MAX_BYTES = SPEECH_MAX_SAMPLES * 2;
export const SPEECH_REQUEST_TIMEOUT_MS = 90000;
export type SpeechResult = { text: string; durationMs: number };
