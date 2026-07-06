import * as React from 'react';

import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /**
   * Flags a validation error (E4): paints a destructive border + focus ring and
   * sets aria-invalid, so screens stop hand-rolling inline `border-destructive`
   * hacks. Pair with a message in destructive text next to the field.
   */
  invalid?: boolean;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, invalid, ...props }, ref) => {
    return (
      <input
        type={type}
        aria-invalid={invalid || undefined}
        className={cn(
          // h-11 (44px) meets the iOS touch-target floor; text-base (16px) on
          // mobile prevents Safari's focus auto-zoom, dropping to text-sm on
          // larger (pointer) screens. rounded-lg aligns with the F2 control scale.
          'flex h-11 w-full rounded-lg border border-input bg-transparent px-3 py-1 text-base transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
          invalid &&
            'border-destructive focus-visible:ring-destructive aria-[invalid]:border-destructive',
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';

export { Input };
