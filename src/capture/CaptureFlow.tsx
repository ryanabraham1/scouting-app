import { useLayoutEffect, type ReactNode } from 'react';
import {
  CaptureScreen,
  type CaptureObservedAction,
} from '@/capture/CaptureScreen';
import {
  ReviewScreen,
  type ReviewObservedAction,
} from '@/capture/ReviewScreen';
import {
  useCaptureSession,
  type CaptureFlowStage,
  type CaptureTarget,
} from '@/capture/useCaptureSession';
import type { CaptureSessionStorage } from '@/capture/captureSessionStorage';
import type { TeamAutoHistory } from '@/capture/useTeamAutoHistory';
import { beginPwaUpdateBlock } from '@/pwa/registerPwa';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export type { CaptureFlowStage } from '@/capture/useCaptureSession';
export type CaptureSession = ReturnType<typeof useCaptureSession>;

export interface CaptureFlowFrameContext {
  stage: CaptureFlowStage;
  session: CaptureSession;
  content: ReactNode;
}

export interface CaptureFlowProps {
  target: CaptureTarget;
  onDone: (reportId: string) => void;
  onExit: () => void;
  startStage?: CaptureFlowStage;
  editingRevision?: number;
  storage?: CaptureSessionStorage;
  now?: () => number;
  autoHistory?: TeamAutoHistory;
  onAction?: (action: CaptureObservedAction) => void;
  onReviewStepChange?: (step: number) => void;
  onReviewAction?: (action: ReviewObservedAction) => void;
  /**
   * Optional chrome around the unchanged production screens. Practice uses this
   * for its coach rail; production omits it and receives the screen directly.
   */
  renderFrame?: (context: CaptureFlowFrameContext) => ReactNode;
}

export function CaptureFlow(props: CaptureFlowProps): JSX.Element {
  useLayoutEffect(() => beginPwaUpdateBlock(), []);
  const session = useCaptureSession(props.target, {
    storage: props.storage,
    now: props.now,
    initialStage: props.startStage,
  });
  const stage = session.flowStage;

  if (session.hydrationStatus !== 'ready') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background p-6 text-center text-foreground">
        {session.hydrationStatus === 'loading' ? (
          <>
            <Loader2 className="size-7 animate-spin text-brand" />
            <p role="status">Restoring saved match work…</p>
          </>
        ) : (
          <>
            <p role="alert" className="max-w-md text-destructive">
              {session.storageError ?? 'Saved match work could not be opened. Nothing was overwritten.'}
            </p>
            <Button type="button" variant="outline" onClick={props.onExit}>Exit safely</Button>
          </>
        )}
      </div>
    );
  }

  const content =
    stage === 'review' ? (
      <ReviewScreen
        session={session}
        onSaved={(id) => props.onDone(id)}
        onExit={props.onExit}
        editingRevision={props.editingRevision}
        autoHistory={props.autoHistory}
        onStepChange={props.onReviewStepChange}
        onAction={props.onReviewAction}
      />
    ) : (
      <CaptureScreen
        session={session}
        onToReview={() => session.setFlowStage('review')}
        onExit={props.onExit}
        onAction={props.onAction}
      />
    );

  return (
    <>
      {props.renderFrame?.({ stage, session, content }) ?? content}
      {session.storageError ? (
        <div
          role="alert"
          className="fixed inset-x-3 bottom-3 z-[80] mx-auto max-w-md rounded-xl border border-destructive/50 bg-card p-3 text-sm text-destructive shadow-xl"
        >
          {session.storageError}
        </div>
      ) : null}
    </>
  );
}

export default CaptureFlow;
