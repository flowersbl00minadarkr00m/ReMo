import type { IncomingMessage, ServerResponse } from "node:http";
import type { EvidenceMediaRole } from "@remo/domain";

export interface EvidenceMediaRouteMatch {
  readonly savePointId: string;
  readonly role: EvidenceMediaRole;
}

export interface EvidenceMediaRouteHandler {
  handle(request: IncomingMessage, response: ServerResponse, match: EvidenceMediaRouteMatch): boolean | Promise<boolean>;
}

export type EvidenceMediaMount = (request: IncomingMessage, response: ServerResponse) => boolean | Promise<boolean>;

export function matchEvidenceMediaRoute(url: string | undefined): EvidenceMediaRouteMatch | undefined {
  const match = /^\/api\/save-points\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/media\/(screenshot|rrweb)$/u.exec(url ?? "");
  return match === null ? undefined : { savePointId: match[1]!, role: match[2]! as EvidenceMediaRole };
}

export function createEvidenceMediaMount(handler: EvidenceMediaRouteHandler): EvidenceMediaMount {
  return (request, response) => {
    const match = matchEvidenceMediaRoute(request.url);
    return match === undefined ? false : handler.handle(request, response, match);
  };
}
