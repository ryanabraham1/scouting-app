// src/qr/QrModeTabs.tsx — Send / Receive switch shared by both QR screens.
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

export function QrModeTabs({ active }: { active: 'send' | 'receive' }): JSX.Element {
  const items = [
    { id: 'send', label: 'Send', href: '/qr/send' },
    { id: 'receive', label: 'Receive', href: '/qr/receive' },
  ] as const;
  return (
    <nav
      aria-label="QR transfer mode"
      data-testid="qr-mode-tabs"
      className="grid w-full max-w-md grid-cols-2 gap-1 rounded-xl bg-secondary p-1"
    >
      {items.map((item) => (
        <Link
          key={item.id}
          to={item.href}
          replace
          data-testid={`qr-mode-${item.id}`}
          aria-current={active === item.id ? 'page' : undefined}
          className={cn(
            'flex h-10 items-center justify-center rounded-lg text-sm transition-colors',
            active === item.id
              ? 'bg-background font-medium text-foreground shadow-sm'
              : 'text-muted-foreground',
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

export default QrModeTabs;
