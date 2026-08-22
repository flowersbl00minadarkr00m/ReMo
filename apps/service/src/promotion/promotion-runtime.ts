import { LocalSavePointRepository, type PromotionCrashPoint } from "@remo/storage-local";
import type { CandidateReviewRecord } from "../candidates/candidate-service.js";
import { createPromotionHandler } from "./promotion-handler.js";
import { createPromotionApi } from "./promotion-api.js";
import { createPromotionService } from "./promotion-service.js";
import { createOperationalDiagnosticsReporter } from "../support/operational-jsonl.js";

export function createLocalPromotionRuntime(options: {
  readonly projectRoot: string;
  readonly findCandidate: (turnId: string) => CandidateReviewRecord | undefined;
  readonly allowedOrigin: string;
  readonly sessionToken?: string;
  readonly now?: () => Date;
  readonly crashPoint?: PromotionCrashPoint;
}) {
  const repository = new LocalSavePointRepository({
    projectRoot: options.projectRoot,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.crashPoint === undefined ? {} : { crashPoint: options.crashPoint }),
  });
  const service = createPromotionService(repository);
  const diagnostics = createOperationalDiagnosticsReporter({ projectRoot: options.projectRoot, ...(options.now === undefined ? {} : { now: options.now }) });
  const handle = createPromotionHandler({ findCandidate: options.findCandidate, promote: (record, intent) => service.promote(record, intent), diagnostics });
  const api = createPromotionApi({ allowedOrigin: options.allowedOrigin, promote: handle, ...(options.sessionToken === undefined ? {} : { sessionToken: options.sessionToken }) });
  return {
    api,
    handle,
    repository,
    diagnostics,
    close(): void { repository.close(); },
  };
}
