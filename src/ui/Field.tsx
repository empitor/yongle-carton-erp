import type { ReactNode } from 'react';

export function Field({
  label,
  children,
  wide = false,
  variant = 'form',
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
  variant?: 'form' | 'flow';
}) {
  return (
    <label
      className={
        variant === 'flow' ? 'op-field' + (wide ? ' op-wide' : '') : wide ? 'field wide' : 'field'
      }
    >
      <span>{label}</span>
      {children}
    </label>
  );
}

export default Field;
