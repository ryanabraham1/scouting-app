// Combines the qual Schedule and the Assignment board behind a single segmented
// toggle so only one long list is on screen at a time — the two used to stack,
// forcing the lead to scroll past the entire schedule to reach assignments.
import { useState } from 'react';
import { CalendarDays, ClipboardList, Wrench } from 'lucide-react';
import { SegmentedToggle } from '@/components/ui/SegmentedToggle';
import { ScheduleView } from './ScheduleView';
import { AssignmentBoard } from './AssignmentBoard';
import { PitAssignmentBoard } from './PitAssignmentBoard';
import type { AssignMatch, AssignScout, AssignTeam } from './types';

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
  return (
    <div className="flex flex-col gap-3">
      <SegmentedToggle
        size="default"
        ariaLabel="Match planning view"
        value={view}
        onChange={setView}
        options={[
          { value: 'assignments', label: 'Match assignments', icon: <ClipboardList /> },
          { value: 'pit', label: 'Pit assignments', icon: <Wrench /> },
          { value: 'schedule', label: 'Schedule', icon: <CalendarDays /> },
        ]}
      />
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
