import { createHash } from 'node:crypto';
import type { PromptPreset, PromptState } from '../../shared/ai/index.js';

/**
 * 默认提示词怎么跟着程序升级：从默认建出来（新库、恢复默认）的预设在 defaults 里记下默认条目的指纹。
 * 打开库时，预设条目还等于它记的指纹（用户没动过）、而程序里的默认已经变了，就换成新默认的条目；
 * 用户改过条目的就不再跟着默认走。预设名字归用户，只看条目、不动名字。
 * 以后改默认文字不用再写任何升级代码。纯函数，不碰库。
 */
export function presetFingerprint(preset: Pick<PromptPreset, 'entries'>) {
  const plain = preset.entries.map(({ name, enabled, content }) => ({ name, enabled, content }));
  return createHash('sha256').update(JSON.stringify(plain)).digest('hex');
}

/** 新库：只有一份当前默认，记着它的指纹。 */
export function initialPromptState(latest: PromptPreset): PromptState {
  return {
    revision: 0,
    activeId: latest.id,
    presets: [latest],
    defaults: { [latest.id]: presetFingerprint(latest) },
  };
}

/** 把一份预设的条目换成新默认的；条目编号按位置沿用，名字不动。 */
function asLatest(preset: PromptPreset, latest: PromptPreset): PromptPreset {
  return {
    ...preset,
    entries: latest.entries.map((entry, i) => ({ ...entry, id: preset.entries[i]?.id ?? entry.id })),
  };
}

/**
 * 打开库时刷新：没动过的默认换成新默认。只有真换了才 changed（调用方写回并加版本号）；
 * 动过的只是不换，不为清理记录单独写库，免得每次打开都改版本号。
 */
export function refreshDefaults(state: PromptState, latest: PromptPreset): { state: PromptState; changed: boolean } {
  const defaults = { ...(state.defaults ?? {}) };
  const target = presetFingerprint(latest);
  let changed = false;
  const presets = state.presets.map((preset) => {
    const recorded = defaults[preset.id];
    if (!recorded || recorded === target || presetFingerprint(preset) !== recorded) return preset;
    defaults[preset.id] = target;
    changed = true;
    return asLatest(preset, latest);
  });
  return { state: { ...state, presets, defaults }, changed };
}

/** 写库前顺手清理：改过的、删掉的预设不再跟踪。 */
export function forgetEdited(state: PromptState): PromptState {
  if (!state.defaults) return state;
  const defaults: Record<string, string> = {};
  for (const preset of state.presets) {
    const recorded = state.defaults[preset.id];
    if (recorded && presetFingerprint(preset) === recorded) defaults[preset.id] = recorded;
  }
  return { ...state, defaults };
}

/** 恢复默认：条目换成当前默认（名字不动），并重新跟着默认走。 */
export function restoreDefault(state: PromptState, id: string, latest: PromptPreset): PromptState {
  return {
    ...state,
    presets: state.presets.map((p) => (p.id === id ? asLatest(p, latest) : p)),
    defaults: { ...(state.defaults ?? {}), [id]: presetFingerprint(latest) },
  };
}
