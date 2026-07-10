import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  applyPendingPwaUpdate,
  getPwaUpdateState,
  subscribePwaUpdate,
} from '@/pwa/registerPwa';

export function PwaUpdatePrompt(): JSX.Element | null {
  const [state, setState] = useState(getPwaUpdateState);
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setState(getPwaUpdateState());
    return subscribePwaUpdate(() => setState(getPwaUpdateState()));
  }, []);

  if (!state.pending || state.blocked) return null;
  return (
    <div
      data-testid="pwa-update-prompt"
      role="status"
      className="fixed inset-x-3 bottom-3 z-[70] mx-auto flex max-w-md items-center gap-3 rounded-xl border border-brand/40 bg-card p-3 shadow-xl"
    >
      <RefreshCw className="size-5 shrink-0 text-brand" />
      <div className="min-w-0 flex-1 text-sm">
        <p>An app update is ready.</p>
        {error ? <p role="alert" className="mt-1 text-danger">{error}</p> : null}
      </div>
      <Button
        type="button"
        size="sm"
        disabled={activating}
        onClick={() => {
          setActivating(true);
          setError(null);
          void applyPendingPwaUpdate()
            .catch(() => setError('Update failed. Try again.'))
            .finally(() => setActivating(false));
        }}
      >
        {activating ? 'Updating…' : 'Update'}
      </Button>
    </div>
  );
}
