// NumberField — a controlled numeric <input> you can actually edit on a phone.
//
// A plain `value={num}` number input reformats on every keystroke: typing into a
// `.toFixed(1)` field snaps "12" back to "12.0", and clearing the field coerces the
// empty string to 0, so you can never delete-and-retype. This holds a local string
// DRAFT while the field is focused/being edited so keystrokes are preserved, commits
// a parsed (clamped ≥0) number via `onCommit`, and reverts to `format(value)` on blur.
import { useState } from 'react';

type Props = {
  /** current value in the DISPLAY domain (e.g. seconds, not ms) */
  value: number;
  /** called with the parsed, clamped-≥0 value on each valid keystroke */
  onCommit: (n: number) => void;
  /** render the committed value when not mid-edit (default: String) */
  format?: (n: number) => string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>;

export function NumberField({ value, onCommit, format, ...rest }: Props): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? (format ? format(value) : String(value));
  return (
    <input
      type="number"
      value={display}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        if (raw === '') return; // transient empty state — don't clobber the value
        const n = Number(raw);
        if (Number.isFinite(n)) onCommit(Math.max(0, n));
      }}
      onBlur={() => setDraft(null)} // revert to the formatted committed value
      {...rest}
    />
  );
}
