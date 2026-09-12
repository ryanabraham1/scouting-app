import { useEffect, useState } from 'react';
import { useTeamPit } from '@/dash/useTeamPit';
import { getPitReport } from '@/pit/pitStore';

interface LocalSuggestion {
  key: string;
  reportFound: boolean;
  value: number | null;
}

/**
 * Resolve the pit-scout BPS estimate for a match target. A submitted local
 * report wins so the suggestion works immediately on the pit-scouting device,
 * including while its outbox is offline. Otherwise use the persisted React
 * Query copy of the Supabase row (and refresh it when connectivity permits).
 */
export function usePitBpsSuggestion(
  eventKey: string | null | undefined,
  teamNumber: number | null | undefined,
): number | null {
  const remote = useTeamPit(eventKey, teamNumber);
  const [local, setLocal] = useState<LocalSuggestion | null>(null);
  const key = eventKey && teamNumber != null ? `${eventKey}:${teamNumber}` : '';

  useEffect(() => {
    if (!eventKey || teamNumber == null) {
      setLocal(null);
      return;
    }
    let cancelled = false;
    void getPitReport(eventKey, teamNumber)
      .then((report) => {
        if (cancelled) return;
        setLocal({
          key: `${eventKey}:${teamNumber}`,
          reportFound: Boolean(report),
          value: report?.data.questionnaire?.estimatedBallsPerSecond ?? null,
        });
      })
      .catch(() => {
        if (cancelled) return;
        // IndexedDB being unavailable must not block the cached/network source.
        setLocal({ key: `${eventKey}:${teamNumber}`, reportFound: false, value: null });
      });
    return () => {
      cancelled = true;
    };
  }, [eventKey, teamNumber]);

  const currentLocal = local?.key === key ? local : null;
  if (currentLocal?.reportFound) return currentLocal.value;
  return remote.data?.questionnaire?.estimatedBallsPerSecond ?? null;
}

export default usePitBpsSuggestion;
