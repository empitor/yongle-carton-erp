/**
 * 编辑窗的必填引导：保存报错时，把标了星号（或 aria-required）却还空着的输入框标红，
 * 滚到第一个并聚焦，返回这些字段的名字，让人一眼看出哪里没填。
 * 只看界面上能看见、能操作的控件；填上以后红框自动消失。
 */
const CONTROLS =
  'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="file"]),select,textarea';

type Missing = { target: HTMLElement; focus: HTMLElement; name: string };

const visible = (el: HTMLElement) => el.getClientRects().length > 0;
const blank = (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => !String(el.value ?? '').trim();
/** 是不是能填的控件（CONTROLS 选出来的都是输入框、下拉、多行文字） */
const isControl = (el: Element): el is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
  el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
const disabled = (el: Element) => isControl(el) && el.disabled;

/** 一个字段是不是还空着：可搜索下拉看它记下的选中值，普通输入看内容。 */
function fieldEmpty(field: HTMLElement) {
  const combo = field.querySelector<HTMLElement>('.combobox[data-value]');
  if (combo) return combo.dataset.value === '';
  const controls = [...field.querySelectorAll<HTMLInputElement>(CONTROLS)].filter((c) => !c.disabled);
  // 一格里有数量和单位两个控件时，看标了必填的那个；都没标就要全空才算没填
  const required = controls.filter((c) => c.required || c.getAttribute('aria-required') === 'true');
  return required.length ? required.some(blank) : controls.length > 0 && controls.every(blank);
}

/** 单个控件是不是空着：可搜索下拉里的输入框看下拉记下的选中值。 */
function controlEmpty(control: Element) {
  const combo = control.closest<HTMLElement>('.combobox[data-value]');
  if (combo) return combo.dataset.value === '';
  // 标红的只有字段外框和控件；不是控件的没有值可看，算空着
  return isControl(control) ? blank(control) : true;
}

const labelOf = (field: HTMLElement) =>
  (field.querySelector('.form-field-label')?.textContent || '').replace(/\*\s*$/, '').trim();

export function findMissing(root: HTMLElement): Missing[] {
  const out: Missing[] = [];
  for (const field of root.querySelectorAll<HTMLElement>('.form-field')) {
    if (!field.querySelector(':scope > .form-field-label > .required-mark') || !visible(field)) continue;
    if (!fieldEmpty(field)) continue;
    const focus =
      [...field.querySelectorAll<HTMLInputElement>(CONTROLS)].find(
        (c) => !c.disabled && (c.required || c.getAttribute('aria-required') === 'true') && blank(c),
      ) || field.querySelector<HTMLElement>(CONTROLS);
    if (focus && !disabled(focus)) out.push({ target: field, focus, name: labelOf(field) });
  }
  // 表格里的明细输入框没有字段外框，用 aria-required 或 required 标出必填
  for (const control of root.querySelectorAll<HTMLInputElement>(
    '[aria-required="true"], input[required], select[required], textarea[required]',
  )) {
    if (control.closest('.form-field')?.querySelector(':scope > .form-field-label > .required-mark')) continue;
    if (control.disabled || !visible(control) || !controlEmpty(control)) continue;
    out.push({ target: control, focus: control, name: control.getAttribute('aria-label') || '' });
  }
  return out;
}

/** 标红、滚过去、聚焦第一个，返回字段名（去重）。 */
export function markMissing(root: HTMLElement): string[] {
  clearMissing(root);
  const found = findMissing(root);
  for (const m of found) m.target.classList.add('is-missing');
  const first = found[0];
  if (first) {
    first.target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    first.focus.focus({ preventScroll: true });
  }
  return [...new Set(found.map((m) => m.name).filter(Boolean))];
}

/** 已经填上的去掉红框；返回还空着的字段名。 */
export function refreshMissing(root: HTMLElement): string[] {
  const names: string[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('.is-missing')) {
    const empty = el.classList.contains('form-field')
      ? fieldEmpty(el)
      : controlEmpty(el);
    if (!empty || !visible(el)) el.classList.remove('is-missing');
    else names.push(el.classList.contains('form-field') ? labelOf(el) : el.getAttribute('aria-label') || '');
  }
  return [...new Set(names.filter(Boolean))];
}

export function clearMissing(root: HTMLElement) {
  for (const el of root.querySelectorAll('.is-missing')) el.classList.remove('is-missing');
}
