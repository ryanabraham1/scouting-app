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
  { id: 'left-line', screen: 'live', task: 'Use Left Line when needed.', detail: 'Use this when the robot fully leaves its Auto starting line.', target: '[data-testid="capture-left-line"]', optional: true, action: 'left_line' },
  { id: 'auto-climb', screen: 'live', task: 'Use Auto Climb when needed.', detail: 'Use this only if the robot completes the level-one climb during Auto.', target: '[data-testid="capture-auto-climb"]', optional: true, action: 'auto_climb' },
  { id: 'go', screen: 'live', task: 'Start Teleop.', detail: 'Do this now: press GO when drivers take control.', target: '[data-testid="capture-go"]', optional: false, action: 'go_pressed' },
  { id: 'inactive-first', screen: 'live', task: 'Answer the HUB question.', detail: 'Do this now: choose whether your alliance’s scoring HUB became inactive first.', target: '[data-testid="capture-go-interstitial"]', optional: false, action: 'inactive_answered' },
  { id: 'teleop-fuel', screen: 'live', task: 'Record Teleop fuel.', detail: 'Do this now: use the orange fuel control for one driver-controlled scoring burst.', target: '[data-testid="capture-hold"]', optional: false, action: 'fuel_burst' },
  { id: 'feed', screen: 'live', task: 'Record feeding.', detail: 'Do this now: use the blue control when fuel is passed to an alliance partner.', target: '[data-testid="capture-feed"]', optional: false, action: 'feeding_burst' },
  { id: 'defense-lock', screen: 'live', task: 'Lock the defense timer.', detail: 'Do this now: hold Playing defense and slide right to keep it running.', target: '[data-testid="capture-defense"]', optional: false, action: 'defense_locked' },
  { id: 'defense-stop', screen: 'live', task: 'Stop the defense timer.', detail: 'Do this now: tap the locked timer when the robot stops defending.', target: '[data-testid="capture-defense"]', optional: false, action: 'defense_stopped' },
  { id: 'defended-lock', screen: 'live', task: 'Lock the defended timer.', detail: 'Do this now: hold Getting defended and slide right when an opponent blocks this robot.', target: '[data-testid="capture-defended"]', optional: false, action: 'defended_locked' },
  { id: 'defended-stop', screen: 'live', task: 'Stop the defended timer.', detail: 'Do this now: tap the locked timer when the opponent stops blocking.', target: '[data-testid="capture-defended"]', optional: false, action: 'defended_stopped' },
  { id: 'foul', screen: 'live', task: 'Record a foul.', detail: 'Do this now: tap Foul once to learn where rule violations are counted.', target: '[data-testid="capture-foul"]', optional: false, action: 'foul_added' },
  { id: 'undo', screen: 'live', task: 'Undo the last action.', detail: 'Do this now: tap Undo to remove the practice foul.', target: '[data-testid="capture-undo"]', optional: false, action: 'undo' },
  { id: 'reanchor', screen: 'live', task: 'Use the endgame cue when needed.', detail: 'Use this if your timer drifts: tap it when the field clock reaches 0:30.', target: '[data-testid="capture-reanchor"]', optional: true, action: 'reanchored' },
  { id: 'to-review', screen: 'live', task: 'Open Review.', detail: 'Do this now: tap To Review when live action is finished.', target: '[data-testid="capture-to-review"]', optional: false, action: 'to_review' },

  { id: 'climb-level', screen: 'review', page: 0, task: 'Choose the climb level.', detail: 'Use this when the robot finishes on a climb level; choose 0 for no climb.', target: '[data-testid="review-climb"]', optional: true, action: 'climb_level' },
  { id: 'climb-attempted', screen: 'review', page: 0, task: 'Mark a climb attempt.', detail: 'Use this when the robot tried to climb, even if it did not finish.', target: '[data-testid="review-climb-outcome"]', optional: true, action: 'climb_attempted' },
  { id: 'climb-success', screen: 'review', page: 0, task: 'Mark climb success.', detail: 'Use this when the robot completed the climb.', target: '[data-testid="review-climb-outcome"]', optional: true, action: 'climb_success' },
  { id: 'climb-next', screen: 'review', page: 0, task: 'Open defense and handling.', detail: 'Do this now: tap Next for more after-match details.', target: '[data-testid="review-next"]', optional: false, action: 'next' },

  { id: 'intake', screen: 'review', page: 1, task: 'Mark intake sources.', detail: 'Use this to show where the robot collected fuel.', target: '[data-testid="review-intake-sources"]', optional: true, action: 'intake_sources' },
  { id: 'defense-seconds', screen: 'review', page: 1, task: 'Correct defense time if needed.', detail: 'Use this only when the live defense timer needs a correction.', target: '[data-testid="review-defense-seconds"]', optional: true, action: 'defense_seconds' },
  { id: 'defended-seconds', screen: 'review', page: 1, task: 'Correct defended time if needed.', detail: 'Use this only when the Getting defended timer needs a correction.', target: '[data-testid="review-defended-seconds"]', optional: true, action: 'defended_seconds' },
  { id: 'pins', screen: 'review', page: 1, task: 'Record pins when seen.', detail: 'Use this for the number of clear pinning actions you observed.', target: '[data-testid="review-pins"]', optional: true, action: 'pins' },
  { id: 'capacity', screen: 'review', page: 1, task: 'Record maximum capacity.', detail: 'Use this for the most fuel you saw the robot carry at once.', target: '[data-testid="review-max-capacity"]', optional: true, action: 'max_capacity' },
  { id: 'defense-rating', screen: 'review', page: 1, task: 'Rate defense quality.', detail: 'Use the 1–10 slider only when you saw enough defense to judge it.', target: '[data-testid="review-defense-rating"]', optional: true, action: 'defense_rating' },
  { id: 'driver-rating', screen: 'review', page: 1, task: 'Rate driver skill.', detail: 'Use the 1–10 slider for the driver control you observed.', target: '[data-testid="review-driver-skill"]', optional: true, action: 'driver_rating' },
  { id: 'agility-rating', screen: 'review', page: 1, task: 'Rate agility.', detail: 'Use the 1–10 slider for how quickly and smoothly the robot moved.', target: '[data-testid="review-agility"]', optional: true, action: 'agility_rating' },
  { id: 'rating-clear', screen: 'review', page: 1, task: 'Clear a rating when unsure.', detail: 'Use Clear to return a rating to Not rated. Not rated is better than guessing.', target: '[data-testid="review-defense-rating-clear"]', optional: true, action: 'rating_clear' },
  { id: 'handling-next', screen: 'review', page: 1, task: 'Open fouls and flags.', detail: 'Do this now: tap Next.', target: '[data-testid="review-next"]', optional: false, action: 'next' },

  { id: 'minor-fouls', screen: 'review', page: 2, task: 'Check minor fouls.', detail: 'Use this to correct the number of minor fouls.', target: '[data-testid="review-fouls-minor"]', optional: true, action: 'fouls_minor' },
  { id: 'major-fouls', screen: 'review', page: 2, task: 'Check major fouls.', detail: 'Use this to record major fouls only when clearly observed.', target: '[data-testid="review-fouls-major"]', optional: true, action: 'fouls_major' },
  { id: 'foul-reasons', screen: 'review', page: 2, task: 'Add foul reasons when known.', detail: 'Use these choices only when you know what caused the foul.', target: '[data-testid="review-foul-reasons"]', optional: true, action: 'foul_reason' },
  { id: 'flags', screen: 'review', page: 2, task: 'Mark important match flags.', detail: 'Use No show, Died, Tipped, or Dropped only when each happened.', target: '[data-testid="review-flags"]', optional: true, action: 'flag' },
  { id: 'flags-next', screen: 'review', page: 2, task: 'Open the Auto path.', detail: 'Do this now: tap Next.', target: '[data-testid="review-next"]', optional: false, action: 'next' },

  { id: 'auto-path', screen: 'review', page: 3, task: 'Confirm the Auto start and path.', detail: 'Check the start marker, then draw the programmed route when you saw it.', target: '[data-testid="review-field-path"]', optional: true, action: 'auto_path' },
  { id: 'auto-next', screen: 'review', page: 3, task: 'Open the match summary.', detail: 'Do this now: tap Next.', target: '[data-testid="review-next"]', optional: false, action: 'next' },

  { id: 'summary', screen: 'review', page: 4, task: 'Check the summary.', detail: 'Use this to catch a number that does not match what you saw.', target: '[data-testid="review-summary"]', optional: true },
  { id: 'notes', screen: 'review', page: 4, task: 'Add a useful note.', detail: 'Use notes for something important the buttons did not capture.', target: '[data-testid="review-notes"]', optional: true, action: 'notes' },
  { id: 'save', screen: 'review', page: 4, task: 'Finish the match report.', detail: 'Do this now: SAVE finishes this practice module. In a real match, it saves the report on this device for sending.', target: '[data-testid="review-save"]', optional: false },
] as const;

export const PIT_COACH_STEPS: readonly PitCoachStep[] = [
  { id: 'drivetrain', page: 0, task: 'Choose the drivetrain.', detail: 'Do this now: select the wheel system the team uses.', target: '[data-testid="pit-drivetrain"]', optional: false, action: 'drivetrain' },
  { id: 'mechanisms', page: 0, task: 'Mark known mechanisms.', detail: 'Use these choices for parts such as the intake, shooter, or climber.', target: '[data-testid="pit-mechanisms"]', optional: true, action: 'mechanism' },
  { id: 'mechanism-other', page: 0, task: 'Add another mechanism when needed.', detail: 'Use Other for an important mechanism that is not listed.', target: '[data-testid="pit-mechanisms-other"]', optional: true, action: 'mechanism_other' },
  { id: 'page-0-next', page: 0, task: 'Open capabilities and intake.', detail: 'Do this now: tap Next.', target: '[data-testid="pit-next"]', optional: false, action: 'next' },

  { id: 'capabilities', page: 1, task: 'Mark robot capabilities.', detail: 'Use these choices for Auto, climb levels, and defense.', target: '[data-testid="pit-capabilities"]', optional: true, action: 'capability' },
  { id: 'intake-sources', page: 1, task: 'Mark intake sources.', detail: 'Use these choices for every place the robot can collect fuel.', target: '[data-testid="pit-intake-sources"]', optional: true, action: 'intake_source' },
  { id: 'page-1-next', page: 1, task: 'Open strategy, vision, and power.', detail: 'Do this now: tap Next.', target: '[data-testid="pit-next"]', optional: false, action: 'next' },

  { id: 'strategy', page: 2, task: 'Mark preferred match strategy.', detail: 'Use these choices for the roles the team expects to play.', target: '[data-testid="pit-match-strategy"]', optional: true, action: 'strategy' },
  { id: 'vision', page: 2, task: 'Enter the vision system.', detail: 'Use this for the camera or software that helps the robot aim; enter none when appropriate.', target: '[data-testid="pit-vision"]', optional: true, action: 'vision' },
  { id: 'battery-count', page: 2, task: 'Enter the battery count.', detail: 'Use this for the number of competition batteries the team brought.', target: '[data-testid="pit-battery-count"]', optional: true, action: 'battery_count' },
  { id: 'charger-count', page: 2, task: 'Enter the charger count.', detail: 'Use this for the number of chargers available.', target: '[data-testid="pit-charger-count"]', optional: true, action: 'charger_count' },
  { id: 'battery-brand', page: 2, task: 'Enter the battery brand.', detail: 'Use this when the team knows the brand.', target: '[data-testid="pit-battery-brand"]', optional: true, action: 'battery_brand' },
  { id: 'battery-connector', page: 2, task: 'Enter the connector type.', detail: 'Use this when the team knows its battery connector.', target: '[data-testid="pit-battery-connector"]', optional: true, action: 'battery_connector' },
  { id: 'page-2-next', page: 2, task: 'Open robot dimensions.', detail: 'Do this now: tap Next.', target: '[data-testid="pit-next"]', optional: false, action: 'next' },

  { id: 'length', page: 3, task: 'Enter robot length.', detail: 'Use inches and include bumpers.', target: '[data-testid="pit-length"]', optional: true, action: 'length' },
  { id: 'width', page: 3, task: 'Enter robot width.', detail: 'Use inches and include bumpers.', target: '[data-testid="pit-width"]', optional: true, action: 'width' },
  { id: 'height', page: 3, task: 'Enter robot height.', detail: 'Use the robot’s normal starting height in inches.', target: '[data-testid="pit-height"]', optional: true, action: 'height' },
  { id: 'trench', page: 3, task: 'Mark trench capability.', detail: 'Use this when the robot can fit through the trench.', target: '[data-testid="pit-trench"]', optional: true, action: 'trench' },
  { id: 'page-3-next', page: 3, task: 'Open preferred Auto.', detail: 'Do this now: tap Next.', target: '[data-testid="pit-next"]', optional: false, action: 'next' },

  { id: 'auto-set-mode', page: 4, task: 'Choose Set start.', detail: 'Use this mode to place the team’s preferred Auto starting spot.', target: '[data-testid="pit-auto-pick-start"]', optional: true, action: 'auto_pick_mode' },
  { id: 'auto-start', page: 4, task: 'Place the preferred Auto start.', detail: 'Do this now: tap the field where the team plans to start.', target: '[data-testid="pit-auto-field"]', optional: false, action: 'auto_start' },
  { id: 'auto-draw-mode', page: 4, task: 'Choose Draw path.', detail: 'Use this mode to record the route the team plans to drive.', target: '[data-testid="pit-auto-draw-path"]', optional: true, action: 'auto_draw_mode' },
  { id: 'auto-path', page: 4, task: 'Draw the preferred Auto path.', detail: 'Use this when the team can describe its planned route.', target: '[data-testid="pit-auto-field"]', optional: true, action: 'auto_path' },
  { id: 'auto-clear', page: 4, task: 'Clear the Auto drawing when needed.', detail: 'Use Clear to remove both the start and path before drawing again.', target: '[data-testid="pit-auto-clear"]', optional: true, action: 'auto_clear' },
  { id: 'page-4-next', page: 4, task: 'Open notes and photos.', detail: 'Do this now: tap Next.', target: '[data-testid="pit-next"]', optional: false, action: 'next' },

  { id: 'notes', page: 5, task: 'Add a useful pit note.', detail: 'Use notes for details that do not fit the choices above.', target: '[data-testid="pit-notes"]', optional: true, action: 'notes' },
  { id: 'camera', page: 5, task: 'Take a robot photo when allowed.', detail: 'Use the camera for a clear full-robot view.', target: '[data-testid="pit-camera-control"]', optional: true, action: 'photo' },
  { id: 'photos', page: 5, task: 'Choose existing photos when needed.', detail: 'Use this to add clear robot pictures already on the device.', target: '[data-testid="pit-photo-control"]', optional: true, action: 'photo' },
  { id: 'submit', page: 5, task: 'Finish the pit report.', detail: 'Do this now: Submit finishes this practice module. In real scouting, it saves the shared team report for sending.', target: '[data-testid="pit-submit"]', optional: false },
] as const;

export const MATCH_STEP_COUNT = MATCH_COACH_STEPS.length;
export const PIT_STEP_COUNT = PIT_COACH_STEPS.length;
