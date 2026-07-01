// Combines the qual Schedule and the Assignment board behind a single segmented
// toggle so only one long list is on screen at a time — the two used to stack,
// forcing the lead to scroll past the entire schedule to reach assignments.
import { useState } from 'react';
import { CalendarDays, ClipboardList } from 'lucide-react';
import { SegmentedToggle } from '@/components/ui/SegmentedToggle';
import { ScheduleView } from './ScheduleView';
import { AssignmentBoard } from './AssignmentBoard';
import type { AssignMatch, AssignScout } from './types';

type PlannerView = 'assignments' | 'schedule';

export interface MatchPlannerProps {
  eventKey: string;
  matches: AssignMatch[];
  scouts: AssignScout[];
}

export function MatchPlanner({ eventKey, matches, scouts }: MatchPlannerProps): JSX.Element {
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
          { value: 'assignments', label: 'Assignments', icon: <ClipboardList /> },
          { value: 'schedule', label: 'Schedule', icon: <CalendarDays /> },
        ]}
      />
      {view === 'assignments' ? (
        <AssignmentBoard eventKey={eventKey} matches={matches} scouts={scouts} />
      ) : (
        <ScheduleView eventKey={eventKey} />
      )}
    </div>
  );
}

export default MatchPlanner;
