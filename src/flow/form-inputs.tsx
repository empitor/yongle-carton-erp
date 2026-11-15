/** 单据编辑窗里的日期、时间输入框：空值显示成空，时间清空存 null。 */
export const dateInput = (
  value: string | null | undefined,
  set: (v: string) => void,
  label: string,
) => (
  <input type="date" aria-label={label} value={value || ''} onChange={(e) => set(e.target.value)} />
);
export const timeInput = (
  value: string | null | undefined,
  set: (v: string | null) => void,
  label: string,
) => (
  <input
    type="time"
    aria-label={label}
    value={value || ''}
    onChange={(e) => set(e.target.value || null)}
  />
);
