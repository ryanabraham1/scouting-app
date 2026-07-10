import { useId, type CSSProperties } from 'react';
import { Button } from '@/components/ui/button';
import {
  QUALITATIVE_RATING_MAX,
  type QualitativeRating,
} from '@/ratings';

interface RatingSliderProps {
  label: string;
  value: QualitativeRating;
  onChange: (value: QualitativeRating) => void;
  testId?: string;
}

function ratingValueText(value: QualitativeRating): string {
  return value === 0 ? 'Not rated' : `${value} out of ${QUALITATIVE_RATING_MAX}`;
}

/**
 * A compact subjective rating control. Zero remains the explicit "not rated"
 * value; rated values use the existing 1–10 qualitative scale.
 */
export function RatingSlider({
  label,
  value,
  onChange,
  testId,
}: RatingSliderProps): JSX.Element {
  const generatedId = useId();
  const inputId = `${generatedId}-rating`;
  const valueText = ratingValueText(value);
  const fillPercent = (value / QUALITATIVE_RATING_MAX) * 100;
  const sliderStyle: CSSProperties = {
    backgroundImage: `linear-gradient(to right, hsl(var(--brand)) 0%, hsl(var(--brand)) ${fillPercent}%, hsl(var(--input)) ${fillPercent}%, hsl(var(--input)) 100%)`,
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
    backgroundSize: '100% 0.75rem',
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-h-11 items-center justify-between gap-3">
        <label
          htmlFor={inputId}
          className="min-w-0 text-sm font-semibold text-foreground"
        >
          {label}
        </label>
        <div className="flex shrink-0 items-center gap-2">
          <output
            htmlFor={inputId}
            data-testid={testId ? `${testId}-value` : undefined}
            className={`min-w-[5.5rem] rounded-lg border px-2.5 py-1 text-center font-mono text-sm font-bold tabular-nums ${
              value === 0
                ? 'border-border bg-muted text-muted-foreground'
                : 'border-brand/60 bg-brand/10 text-foreground'
            }`}
            aria-live="polite"
          >
            {value === 0 ? 'Not rated' : `${value} / 10`}
          </output>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11 min-w-11 px-3 text-xs"
            data-testid={testId ? `${testId}-clear` : undefined}
            disabled={value === 0}
            aria-label={`Clear ${label} rating`}
            onClick={() => onChange(0)}
          >
            Clear
          </Button>
        </div>
      </div>

      <input
        id={inputId}
        type="range"
        min={0}
        max={QUALITATIVE_RATING_MAX}
        step={1}
        value={value}
        data-testid={testId}
        aria-valuetext={valueText}
        onChange={(event) =>
          onChange(Number(event.currentTarget.value) as QualitativeRating)
        }
        style={sliderStyle}
        className="h-11 w-full cursor-pointer appearance-none rounded-full bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-background [&::-moz-range-thumb]:size-7 [&::-moz-range-thumb]:cursor-grab [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-brand [&::-moz-range-thumb]:bg-background [&::-moz-range-thumb]:shadow-md [&::-moz-range-track]:h-3 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-transparent [&::-webkit-slider-thumb]:size-7 [&::-webkit-slider-thumb]:cursor-grab [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-brand [&::-webkit-slider-thumb]:bg-background [&::-webkit-slider-thumb]:shadow-md active:[&::-moz-range-thumb]:cursor-grabbing active:[&::-webkit-slider-thumb]:cursor-grabbing"
      />

      <div
        aria-hidden="true"
        className="grid grid-cols-3 px-0.5 text-[10px] font-medium text-muted-foreground"
      >
        <span>0 · Not rated</span>
        <span className="text-center">5 · Average</span>
        <span className="text-right">10 · Elite</span>
      </div>
    </div>
  );
}
