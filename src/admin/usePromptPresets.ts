import { useEffect, useState } from 'react';
import type { PromptAction, PromptModuleId, PromptPreset, PromptSettingsView } from '../../shared/ai/index';
import { errorMessage } from '../../shared/core/index';
import { changePrompts, readPrompts } from './settings-api';

/** 要先确认的事：放弃未保存修改、删除预设、恢复默认条目。 */
type Pending = { kind: 'leave'; run: () => void } | { kind: 'delete' | 'restore'; id: string };
/** 对一份预设办的事：复制、启用、删除、恢复默认条目 */
type PresetAction = Exclude<PromptAction, 'save'>;
const doneText: Record<PresetAction, string> = {
  copy: '已复制为新预设，改好后保存并启用。',
  activate: '已启用这份提示词。',
  delete: '提示词预设已删除。',
  restore: '已恢复默认条目并保存。',
};

/** 读到的设置里选哪一份：指定的那份，没有就选正在用的那份（复制一份，编辑不碰读来的） */
function chosen(next: PromptSettingsView, id?: string) {
  const preset = next.presets.find((p) => p.id === id) || next.presets.find((p) => p.id === next.activeId);
  return preset ? structuredClone(preset) : null;
}

/**
 * 浏览器离开页面前先问一句（“离开此页？”）的处理函数。返回不是 null 的值：新浏览器认它，Chrome、Edge 118 及更早
 * 只认这种（或废弃的 returnValue），不认 preventDefault。
 */
const askBeforeLeaving = () => '';
/** 有没保存的修改就让浏览器离开页面前先问一句；没有（保存了、放弃了）就不问。target 平时是 window */
export function warnBeforeLeaving(target: Pick<Window, 'onbeforeunload'>, dirty: boolean) {
  target.onbeforeunload = dirty ? askBeforeLeaving : null;
}
/** 有未保存修改时离开页面先问一句；离开这一页（卸载）就不再问。同一时间只开着一个提示词页（设置页按模块换） */
function useLeaveWarning(dirty: boolean) {
  useEffect(() => {
    warnBeforeLeaving(window, dirty);
    return () => warnBeforeLeaving(window, false);
  }, [dirty]);
}

/** 提示词页的数据：预设列表、正在编辑的那份、未保存的修改、出错和结果提示、要先确认的事；打开时读一次 */
function usePresetData(module: PromptModuleId) {
  const [state, setState] = useState<PromptSettingsView | null>(null),
    [current, setCurrent] = useState<PromptPreset | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [pending, setPending] = useState<Pending | null>(null);
  const saved = state?.presets.find((p) => p.id === current?.id),
    dirty = !!current && JSON.stringify(current) !== JSON.stringify(saved);
  useEffect(() => {
    let live = true;
    readPrompts(module)
      .then((d) => {
        if (!live) return;
        setState(d);
        setCurrent(chosen(d));
      })
      .catch((e: unknown) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [module]);
  useLeaveWarning(dirty);
  return { state, setState, current, setCurrent, busy, setBusy, error, setError, notice, setNotice, pending, setPending, saved, dirty };
}

/**
 * 提示词页的数据和动作：保存、复制、启用、删除、恢复默认条目、新建、换一份编辑。
 * module 是提示词模块（地址 /api/ai/prompt-modules/模块）。
 */
export function usePromptPresets(module: PromptModuleId, assistant: boolean) {
  const data = usePresetData(module);
  const { state, setState, current, setCurrent, setBusy, setError, setNotice, setPending, dirty } = data;
  function accept(next: PromptSettingsView, id?: string) {
    setState(next);
    setCurrent(chosen(next, id));
  }
  /** 有未保存修改时先问一句，确认放弃后再继续。 */
  const guard = (run: () => void) => (dirty ? setPending({ kind: 'leave', run }) : run());
  /** 办一件事：request 拿页面凭证和打开页面时的版本号发请求 */
  async function send(request: (token: string, expectedRevision: number) => Promise<PromptSettingsView>) {
    if (!state) return null;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      return await request(state.csrfToken, state.revision);
    } catch (e) {
      setError(errorMessage(e));
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function save(activate = false) {
    if (!current) return;
    const next = await send((token, expectedRevision) =>
      changePrompts(module, 'save', token, { expectedRevision, preset: current, activate }),
    );
    if (next) {
      accept(next, current.id);
      setNotice(activate ? '已保存并启用，下一次 AI 请求就用这份提示词。' : '已保存，还没启用；要用时点“启用”。');
    }
  }
  async function perform(action: PresetAction, id: string) {
    const known = new Set(state?.presets.map((p) => p.id));
    const confirmed = action === 'delete' || action === 'restore' ? { confirmed: true } : {};
    const next = await send((token, expectedRevision) =>
      changePrompts(module, action, token, { expectedRevision, id, ...confirmed }),
    );
    if (!next) return;
    // 复制出来的那份是读回来的列表里原来没有的；删掉了就选正在用的那份
    const selected =
      action === 'copy' ? next.presets.find((p) => !known.has(p.id))?.id : action === 'delete' ? undefined : id;
    accept(next, selected);
    setNotice(doneText[action]);
  }
  const command = (action: PresetAction, id: string) =>
    guard(() => (action === 'delete' || action === 'restore' ? setPending({ kind: action, id }) : void perform(action, id)));
  function newPreset() {
    guard(() => {
      setCurrent({
        id: crypto.randomUUID(),
        name: assistant ? '新助手预设' : '新识别预设',
        entries: [
          { id: crypto.randomUUID(), name: assistant ? '自定义助手规则' : '自定义识别规则', content: '', enabled: true },
        ],
      });
      setNotice('填好名称和条目后，点“保存并启用”。');
      setError('');
    });
  }
  /** 在左边列表里换一份来编辑 */
  const select = (preset: PromptPreset) => {
    if (current?.id !== preset.id)
      guard(() => {
        setCurrent(structuredClone(preset));
        setError('');
        setNotice('');
      });
  };
  return { ...data, guard, save, perform, command, newPreset, select };
}
export type PromptPresets = ReturnType<typeof usePromptPresets>;
