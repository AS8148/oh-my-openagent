import type { ManagedChildHandle, RunnerOutcome } from "../manager/child-handle"

export type RunRef =
  | { readonly kind: "dag"; readonly runId: string }
  | { readonly kind: "task"; readonly taskId: string }
  | { readonly kind: "workpool"; readonly poolId: string }
  | { readonly kind: "team"; readonly teamRunId: string }

export type RunPauseOwner = {
  readonly parentSessionId: string
  readonly parentPauseSeq: number
  readonly runRef: RunRef
}

export type ResumedChildTurn = {
  readonly turnId: string
  readonly outcome: Promise<RunnerOutcome>
}

export type ChildPausePort = {
  pauseForRun(child: ManagedChildHandle, owner: RunPauseOwner): Promise<{ readonly childSeq: number }>
  resumeTurn(child: ManagedChildHandle, request: RunPauseOwner & {
    readonly resumeId: string
    readonly childSeqCutoff: number
  }): Promise<ResumedChildTurn | { readonly otherHoldLive: true; readonly childSeq: number }>
  holdInput(child: ManagedChildHandle, input: {
    readonly inputId: string
    readonly revision: number
    readonly text: string
  }): Promise<{ readonly entryId: string; readonly duplicate: boolean }>
}
