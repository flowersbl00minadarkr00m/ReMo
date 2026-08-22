export type TurnStopReason = "user" | "boundary-violation" | "source-drift" | "scope-uncertain";
export interface TurnSessionInput { readonly turnId: string; readonly repository: string; readonly route: string; readonly startedAt: string; readonly stopCapture: (reason: TurnStopReason) => Promise<void> }
export type TurnSnapshot =
  | { readonly status: "recording"; readonly turnId: string; readonly repository: string; readonly route: string; readonly startedAt: string }
  | { readonly status: "stopped"; readonly turnId: string; readonly repository: string; readonly route: string; readonly startedAt: string; readonly stoppedAt: string; readonly stopReason: TurnStopReason };
export interface TurnSession { snapshot(): TurnSnapshot; stop(reason: TurnStopReason): Promise<TurnSnapshot> }
export function createTurnSession(input: TurnSessionInput): TurnSession {
  let state: TurnSnapshot = { status: "recording", turnId: input.turnId, repository: input.repository, route: input.route, startedAt: input.startedAt };
  let stopping: Promise<TurnSnapshot> | undefined;
  return {
    snapshot: () => state,
    stop(reason) {
      if (state.status === "stopped") return Promise.resolve(state);
      stopping ??= input.stopCapture(reason).then(() => {
        state = { ...state, status: "stopped", stoppedAt: new Date().toISOString(), stopReason: reason };
        return state;
      });
      return stopping;
    },
  };
}
