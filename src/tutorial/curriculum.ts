import type { CaptureObservedAction } from '@/capture/CaptureScreen';
import type { ReviewObservedAction } from '@/capture/ReviewScreen';
import type { PitObservedAction } from '@/pit/PitScoutScreen';

export interface MatchCoachStep {
  id: string;
  screen: 'live' | 'review';
  page?: number;
  task: string;
  detail: string;
  target: string;
  optional: boolean;
  action?: CaptureObservedAction | ReviewObservedAction;
}

export interface PitCoachStep {
  id: string;
  page: number;
  task: string;
  detail: string;
  target: string;
  optional: boolean;
  action?: PitObservedAction;
}

export const MATCH_COACH_STEPS: readonly MatchCoachStep[] = [
  { id: 'placement', screen: 'live', task: 'Place the robot.', detail: 'Confirm your team and station before starting. Then tap the field where the robot starts.', target: '[data-testid="capture-field"]', optional: false, action: 'placement_set' },
  { id: 'placement-submit', screen: 'live', task: 'Confirm the start.', detail: 'Do this now: tap Submit / Start match after the marker is correct.', target: '[data-testid="capture-placement-submit"]', optional: false, action: 'placement_submitted' },
  { id: 'start', screen: 'live', task: 'Start Auto.', detail: 'Do this now: press START when the autonomous period begins.', target: '[data-testid="capture-start"]', optional: false, action: 'match_started' },
  { id: 'auto-fuel', screen: 'live', task: 'Record Auto fuel.', detail: 'Do this now: hold and slide to the fuel rate you see, then release.', target: '[data-testid="capture-hold"]', optional: false, action: 'fuel_burst' },
  { id: 'auto-extras', screen: 'live', task: 'Know the Auto extras.', detail: 'Use Left Line when the robot fully leaves its starting line. Auto Climb is only for a completed level-one climb.', target: '[data-testid="capture-left-line"]', optional: true },
  { id: 'go', screen: 'live', task: 'Start Teleop.', detail: 'Do this now: press GO when drivers take control.', target: '[data-testid="capture-go"]', optional: false, action: 'go_pressed' },
  { id: 'inactive-first', screen: 'live', task: 'Choose the Auto winner.', detail: 'Do this now: choose the alliance that scored more FUEL in Auto.', target: '[data-testid="capture-go-interstitial"]', optional: false, action: 'inactive_answered' },
  { id: 'teleop-fuel', screen: 'live', task: 'Record Teleop fuel.', detail: 'Do this now: use the orange fuel control for one driver-controlled scoring burst.', target: '[data-testid="capture-hold"]', optional: false, action: 'fuel_burst' },
  { id: 'feed', screen: 'live', task: 'Record feeding.', detail: 'Do this now: use the blue control when fuel is passed to an alliance partner.', target: '[data-testid="capture-feed"]', optional: false, action: 'feeding_burst' },
  { id: 'defense-lock', screen: 'live', task: 'Start the defense timer.', detail: 'Do this now: tap Playing defense once to start its timer.', target: '[data-testid="capture-defense"]', optional: false, action: 'defense_started' },
  { id: 'defense-stop', screen: 'live', task: 'Stop the defense timer.', detail: 'Tap the running timer when defense ends. Getting defended works the same way: tap once to start and again to stop.', target: '[data-testid="capture-defense"]', optional: false, action: 'defense_stopped' },
  { id: 'defended', screen: 'live', task: 'Recognize when the robot is defended.', detail: 'Use Getting defended while an opponent blocks this robot. Tap it again when the pressure ends.', target: '[data-testid="capture-defended"]', optional: true },
  { id: 'to-review', screen: 'live', task: 'Open Review.', detail: 'Do this now: tap To Review when live action is finished.', target: '[data-testid="capture-to-review"]', optional: false, action: 'to_review' },

  { id: 'climb', screen: 'review', page: 0, task: 'Record the climb.', detail: 'Choose the finished level, then mark Attempted and Success only when they apply.', target: '[data-testid="review-climb"]', optional: true, action: 'climb_level' },
  { id: 'handling', screen: 'review', page: 0, task: 'Review handling and ratings.', detail: 'Add intake sources, correct timers or counts if needed, and rate only what you confidently observed. Leave uncertain ratings blank.', target: '[data-testid="review-ratings"]', optional: true, action: 'defense_rating' },
  { id: 'auto-path', screen: 'review', page: 1, task: 'Confirm the Auto path.', detail: 'Check the start marker and draw the programmed route only when you saw it.', target: '[data-testid="review-field-path"]', optional: true, action: 'auto_path' },
  { id: 'fouls-flags', screen: 'review', page: 2, task: 'Check fouls and match flags.', detail: 'Correct foul counts, add a reason when known, and mark No show, Died, Tipped, or Dropped only when observed.', target: '[data-testid="review-foul-reasons"]', optional: true, action: 'foul_reason' },
  { id: 'notes', screen: 'review', page: 2, task: 'Add a useful note.', detail: 'Use notes for something important the buttons did not capture.', target: '[data-testid="review-notes"]', optional: true, action: 'notes' },
  { id: 'save', screen: 'review', page: 2, task: 'Finish the match report.', detail: 'Do this now: Save report finishes this practice module. In a real match, it saves the report on this device for sending.', target: '[data-testid="review-save"]', optional: false },
] as const;

export const PIT_COACH_STEPS: readonly PitCoachStep[] = [
  { id: 'drivetrain', page: 0, task: 'Choose the drivetrain.', detail: 'Do this now: select the wheel system the team uses.', target: '[data-testid="pit-drivetrain"]', optional: false, action: 'drivetrain' },
  { id: 'dimensions', page: 0, task: 'Record robot size and trench fit.', detail: 'Enter length, width, height, weight, and whether the robot fits through the trench.', target: '[data-testid="pit-length"]', optional: true, action: 'length' },
  { id: 'shooter', page: 1, task: 'Record the shooter.', detail: 'Choose the shooter type and capture its range and estimated performance.', target: '[data-testid="pit-shooter-type"]', optional: true, action: 'shooter' },
  { id: 'capabilities', page: 2, task: 'Mark robot capabilities.', detail: 'Record intake locations, scoring and feeding capabilities, accuracy, and cleanup ability.', target: '[data-testid="pit-capabilities"]', optional: true, action: 'capability' },
  { id: 'auto-open', page: 3, task: 'Open the Auto field.', detail: 'Do this now: tap the field preview to open the larger blue-side drawing canvas.', target: '[data-testid="pit-auto-open-drawing"]', optional: false, action: 'auto_open' },
  { id: 'auto-start', page: 3, task: 'Place the Auto start.', detail: 'Do this now: tap the field where this routine starts.', target: '[data-testid="pit-auto-field"]', optional: false, action: 'auto_start' },
  { id: 'auto-draw-mode', page: 3, task: 'Choose Draw path.', detail: 'Use this mode to record the route for this Auto.', target: '[data-testid="pit-auto-draw-path"]', optional: true, action: 'auto_draw_mode' },
  { id: 'auto-path', page: 3, task: 'Draw the Auto path.', detail: 'Drag through the route and add a separate Auto for every routine. When finished, tap Done, then Next.', target: '[data-testid="pit-auto-field"]', optional: true, action: 'auto_path' },
  { id: 'vision', page: 4, task: 'Record vision and robot status.', detail: 'Add the vision system, rebuild details, and any reliability concerns.', target: '[data-testid="pit-vision"]', optional: true, action: 'vision' },
  { id: 'notes', page: 5, task: 'Add a useful pit note.', detail: 'Use notes for details that do not fit the choices above.', target: '[data-testid="pit-notes"]', optional: true, action: 'notes' },
  { id: 'photos', page: 5, task: 'Add a clear robot photo.', detail: 'Take a new photo when allowed, or choose a clear full-robot picture already on the device.', target: '[data-testid="pit-camera-control"]', optional: true, action: 'photo' },
  { id: 'submit', page: 5, task: 'Finish the pit report.', detail: 'Do this now: Submit finishes this practice module. In real scouting, it saves the shared team report for sending.', target: '[data-testid="pit-submit"]', optional: false },
] as const;

export const MATCH_STEP_COUNT = MATCH_COACH_STEPS.length;
export const PIT_STEP_COUNT = PIT_COACH_STEPS.length;
