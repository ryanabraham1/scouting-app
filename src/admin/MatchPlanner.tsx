// Combines the qual Schedule and the Assignment board behind a single segmented
// toggle so only one long list is on screen at a time — the two used to stack,
// forcing the lead to scroll past the entire schedule to reach assignments.
import { useState } from 'react';
import { CalendarDays, ClipboardList, Download, Loader2, Wrench } from 'lucide-react';
import { SegmentedToggle } from '@/components/ui/SegmentedToggle';
import { Button } from '@/components/ui/button';
import { ScheduleView } from './ScheduleView';
import { AssignmentBoard } from './AssignmentBoard';
import { PitAssignmentBoard } from './PitAssignmentBoard';
import type { AssignMatch, AssignScout, AssignTeam } from './types';
import { loadMatchAssignmentSnapshot } from './setAssignmentsClient';
import { loadPitAssignmentSnapshot } from './pitAssignmentsClient';
import {
  getCachedAssignmentsForEvent,
  getCachedMatches,
  getCachedPitAssignmentsForEvent,
} from '@/db/preloadClient';
import { assignmentWorkbookDownload } from './assignmentExport';

type PlannerView = 'assignments' | 'pit' | 'schedule';

export interface MatchPlannerProps {
  eventKey: string;
  matches: AssignMatch[];
  scouts: AssignScout[];
  teams: AssignTeam[];
}

export function MatchPlanner({ eventKey, matches, scouts, teams }: MatchPlannerProps): JSX.Element {
  // Assignments is the actionable view (auto-generate / publish), so it leads.
  const [view, setView] = useState<PlannerView>('assignments');
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  const exportAssignments = async (): Promise<void> => {
    if (exporting) return;
    setExporting(true);
    setExportMessage(null);
    try {
      const [matchResult, pitResult, schedule] = await Promise.all([
        loadMatchAssignmentSnapshot(eventKey)
          .then((snapshot) => ({ rows: snapshot.assignments, cached: false }))
          .catch(async () => ({
            rows: (await getCachedAssignmentsForEvent(eventKey)).map((row) => ({
              matchKey: row.match_key,
              scoutId: row.scout_id,
              allianceColor: row.alliance_color,
              station: row.station,
              targetTeamNumber: row.target_team_number,
            })),
            cached: true,
          })),
        loadPitAssignmentSnapshot(eventKey)
          .then((snapshot) => ({ rows: snapshot.assignments, cached: false }))
          .catch(async () => ({
            rows: (await getCachedPitAssignmentsForEvent(eventKey)).map((row) => ({
              teamNumber: row.team_number,
              scoutId: row.scout_id,
              source: row.source,
            })),
            cached: true,
          })),
        getCachedMatches(eventKey),
      ]);
      const download = await assignmentWorkbookDownload({
        eventKey,
        matches: matchResult.rows,
        pitAssignments: pitResult.rows,
        scouts,
        teams,
        schedule,
      });
      const link = document.createElement('a');
      link.href = download.blobUrl;
      link.download = download.filename;
      link.click();
      URL.revokeObjectURL(download.blobUrl);
      setExportMessage(
        matchResult.cached || pitResult.cached
          ? 'Exported the last schedule saved on this device.'
          : 'Exported the latest published assignments.',
      );
    } catch (error) {
      setExportMessage(
        error instanceof Error ? `Export failed: ${error.message}` : 'Export failed. Try again.',
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedToggle
          size="default"
          className="grid grid-cols-2 sm:inline-flex [&>button:last-child]:col-span-2 sm:[&>button:last-child]:col-span-1"
          ariaLabel="Match planning view"
          value={view}
          onChange={setView}
          options={[
            { value: 'assignments', label: 'Match assignments', icon: <ClipboardList /> },
            { value: 'pit', label: 'Pit assignments', icon: <Wrench /> },
            { value: 'schedule', label: 'Schedule', icon: <CalendarDays /> },
          ]}
        />
        <Button
          type="button"
          variant="outline"
          className="min-h-11 gap-2"
          disabled={exporting}
          data-testid="export-assignment-workbook"
          onClick={() => void exportAssignments()}
        >
          {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
          {exporting ? 'Exporting…' : 'Export Excel'}
        </Button>
      </div>
      {exportMessage ? (
        <p data-testid="assignment-export-message" role="status" className="text-sm text-muted-foreground">
          {exportMessage}
        </p>
      ) : null}
      {view === 'assignments' ? (
        <AssignmentBoard
          key={`match-assignments:${eventKey}`}
          eventKey={eventKey}
          matches={matches}
          scouts={scouts}
        />
      ) : view === 'pit' ? (
        <PitAssignmentBoard
          key={`pit-assignments:${eventKey}`}
          eventKey={eventKey}
          teams={teams}
          scouts={scouts}
        />
      ) : (
        <ScheduleView key={`schedule:${eventKey}`} eventKey={eventKey} />
      )}
    </div>
  );
}

export default MatchPlanner;
