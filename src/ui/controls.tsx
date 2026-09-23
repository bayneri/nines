import { useEffect, useId, useState } from 'react';

/** A text field that commits on Enter or blur, and shows why a value was rejected. */
export function Field({
  label,
  value,
  onCommit,
  suffix,
  placeholder,
  hint,
  width,
}: {
  label: string;
  value: string;
  /** Returns an error message to reject the value. */
  onCommit: (text: string) => string | void;
  suffix?: string;
  placeholder?: string;
  hint?: string;
  width?: number;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setText(value);
    setError(undefined);
  }, [value]);

  const commit = () => {
    if (text === value) return setError(undefined);
    const problem = onCommit(text.trim());
    setError(problem || undefined);
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <span className="input-wrap">
        <input
          id={id}
          value={text}
          placeholder={placeholder}
          style={width ? { width } : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? `${id}-note` : undefined}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setText(value);
              setError(undefined);
            }
          }}
        />
        {suffix && <span className="suffix">{suffix}</span>}
      </span>
      {(error || hint) && (
        <span id={`${id}-note`} className={error ? 'field-error' : 'field-hint'}>
          {error ?? hint}
        </span>
      )}
    </div>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="field">
      <span className="label">{label}</span>
      <span className="segmented" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o.value} role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </span>
    </div>
  );
}

export function Stepper({ label, value, min, max, onChange, format }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void; format?: (v: number) => string }) {
  return (
    <div className="field">
      <span className="label">{label}</span>
      <span className="stepper">
        <button aria-label={`Fewer ${label.toLowerCase()}`} onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min}>
          −
        </button>
        <output aria-live="polite">{format ? format(value) : value}</output>
        <button aria-label={`More ${label.toLowerCase()}`} onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max}>
          +
        </button>
      </span>
    </div>
  );
}

/** Parses "99.9", "99.9%" or "0.999" style availability into a fraction in (0, 1]. */
export function parsePercent(text: string): number | string {
  const n = parseFloat(text.replace('%', ''));
  if (!Number.isFinite(n) || n <= 0 || n > 100) return 'Enter a percentage above 0 and up to 100.';
  return Number(`${n}e-2`);
}

/** Parses a positive whole number of milliseconds; empty means "none" when allowed. */
export function parseMs(text: string, allowEmpty: boolean): number | undefined | string {
  if (text === '' && allowEmpty) return undefined;
  const n = Number(text.replace(/\s*ms$/, ''));
  if (!Number.isInteger(n) || n <= 0) return allowEmpty ? 'Enter whole milliseconds, or leave it empty.' : 'Enter whole milliseconds.';
  return n;
}
