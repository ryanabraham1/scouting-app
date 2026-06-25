// src/pit/PitRoute.tsx — legacy /pit entry. The canonical entry is now the
// Match/Pit toggle on ScoutHome (/scout?mode=pit); the router redirects /pit
// there. Kept as a thin wrapper around the shared PitScoutFlow so it still
// works if mounted directly.
import { useSession } from '@/auth/useSession';
import PitScoutFlow from './PitScoutFlow';

export default function PitRoute(): JSX.Element {
  const { scout } = useSession();

  if (!scout) {
    return (
      <main data-testid="pit-route" className="mx-auto max-w-sm p-6">
        <p className="text-sm text-muted-foreground">Join an event first to pit scout.</p>
      </main>
    );
  }

  return (
    <main data-testid="pit-route" className="mx-auto flex max-w-md flex-col gap-4 px-0 py-6">
      <PitScoutFlow eventKey={scout.event_key} scoutId={scout.id} />
    </main>
  );
}
