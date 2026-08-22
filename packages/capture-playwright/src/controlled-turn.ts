import { nominateMeaningfulChange, type NominationResult, type TypedBoundaryEvent } from "../../domain/src/capture/nomination.js";
import { captureGitSnapshot, detectGitDrift, extractGitTextChanges, type GitSnapshot } from "../../evidence-git/src/index.js";
import { createTurnSession, type TurnSnapshot } from "../../../apps/service/src/turns/turn-session.js";
import { createTurnControlApi } from "../../../apps/service/src/turns/turn-control-api.js";
import { startControlledCapture, type ControlledCaptureConfig } from "./index.js";

export interface ControlledTurnConfig {
  readonly turnId: string;
  readonly repositoryRoot: string;
  readonly allowedSourceRoot: string;
  readonly startedAt: string;
  readonly capture: ControlledCaptureConfig;
}
export interface ControlledTurn {
  snapshot(): TurnSnapshot;
  stop(boundaries: readonly TypedBoundaryEvent[]): Promise<NominationResult>;
}
export interface ActiveTurnBootstrap { readonly repository: string; readonly route: string; readonly turnId: string; readonly startedAt: string; readonly sessionToken: string }
export interface ControlledTurnRuntime {
  readonly sessionToken: string;
  handle: ReturnType<typeof createTurnControlApi>["handle"];
  start(config: ControlledTurnConfig): Promise<{ readonly turn: ControlledTurn; readonly bootstrap: ActiveTurnBootstrap }>;
}
export class ControlledTurnError extends Error {
  readonly reasonCodes: readonly string[];
  constructor(reasonCodes: readonly string[], message: string) { super(message); this.name = "ControlledTurnError"; this.reasonCodes = reasonCodes; }
}

function requireCleanBaseline(snapshot: GitSnapshot): void {
  if (snapshot.status !== "" || snapshot.diff !== "") throw new ControlledTurnError(["source.preexisting-change"], "The controlled turn requires a clean approved source baseline.");
}

export async function startControlledTurn(config: ControlledTurnConfig): Promise<ControlledTurn> {
  const snapshotOptions = { repositoryRoot: config.repositoryRoot, allowedSourceRoot: config.allowedSourceRoot } as const;
  const baseline = await captureGitSnapshot(snapshotOptions);
  requireCleanBaseline(baseline);
  const capture = await startControlledCapture(config.capture);
  const armedBaseline = await captureGitSnapshot(snapshotOptions);
  const startDrift = detectGitDrift(baseline, armedBaseline);
  if (startDrift.drifted) {
    await capture.stop("boundary-violation");
    throw new ControlledTurnError(startDrift.reasonCodes, "Source changed while the capture boundary was being armed.");
  }
  const session = createTurnSession({
    turnId: config.turnId,
    repository: config.repositoryRoot,
    route: `${config.capture.origin}${config.capture.path}`,
    startedAt: config.startedAt,
    stopCapture: async () => capture.stop("user"),
  });
  let settling: Promise<NominationResult> | undefined;
  async function settle(boundaries: readonly TypedBoundaryEvent[]): Promise<NominationResult> {
    await session.stop("user");
    const captureState = capture.state();
    if (captureState.status === "failed") throw new ControlledTurnError([captureState.violation.reasonCode], captureState.violation.explanation);
    const sourceAtStop = await captureGitSnapshot(snapshotOptions);
    const textChanges = extractGitTextChanges(sourceAtStop);
    const nomination = nominateMeaningfulChange({ changes: textChanges.changes, boundaries, uncertainty: textChanges.uncertainPaths.length > 0 });
    const sourceAfterSettle = await captureGitSnapshot(snapshotOptions);
    const settleDrift = detectGitDrift(sourceAtStop, sourceAfterSettle);
    if (settleDrift.drifted) throw new ControlledTurnError(settleDrift.reasonCodes, "Source changed while the turn was settling.");
    return nomination;
  }
  return {
    snapshot: () => session.snapshot(),
    stop(boundaries) {
      settling ??= settle(boundaries).catch((error: unknown) => { settling = undefined; throw error; });
      return settling;
    },
  };
}

export function createControlledTurnRuntime({ allowedOrigin }: { readonly allowedOrigin: string }): ControlledTurnRuntime {
  const api = createTurnControlApi({ allowedOrigin });
  return {
    sessionToken: api.sessionToken,
    handle: (request, response) => api.handle(request, response),
    async start(config) {
      const turn = await startControlledTurn(config);
      api.register(config.turnId, turn);
      return {
        turn,
        bootstrap: {
          repository: config.repositoryRoot,
          route: `${config.capture.origin}${config.capture.path}`,
          turnId: config.turnId,
          startedAt: config.startedAt,
          sessionToken: api.sessionToken,
        },
      };
    },
  };
}
