import type { IncomingMessage, ServerResponse } from "node:http";
import { buildComparisonProjection, ComparisonValidationError, type ComparisonSideInput } from "@remo/domain";

export const COMPARISON_ROUTE_PATH = "/api/comparisons" as const;

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }).end(JSON.stringify(body));
}

export function createComparisonApi(options: { readonly resolveSide: (savePointId: string) => ComparisonSideInput }) {
  return {
    matches(requestUrl: string | undefined): boolean { return requestUrl !== undefined && new URL(requestUrl, "http://127.0.0.1").pathname === COMPARISON_ROUTE_PATH; },
    handle(request: IncomingMessage, response: ServerResponse): boolean {
      if (!this.matches(request.url)) return false;
      if (request.method !== "GET") { writeJson(response, 405, { error: "comparison.read-only" }); return true; }
      if (request.socket.remoteAddress !== "127.0.0.1") { writeJson(response, 403, { error: "comparison.loopback-required" }); return true; }
      const url = new URL(request.url!, "http://127.0.0.1");
      const left = url.searchParams.getAll("left"); const right = url.searchParams.getAll("right");
      if (left.length !== 1 || right.length !== 1 || [...url.searchParams.keys()].some((key) => key !== "left" && key !== "right")) { writeJson(response, 400, { error: "comparison.explicit-pair-required", message: "Choose exactly one before and one after save point." }); return true; }
      try { writeJson(response, 200, buildComparisonProjection(options.resolveSide(left[0]!), options.resolveSide(right[0]!))); }
      catch (error) {
        if (error instanceof ComparisonValidationError) { writeJson(response, 400, { error: error.code, message: error.message }); return true; }
        writeJson(response, 409, { error: "comparison.projection-unavailable", message: "The safe comparison projection could not be built." }); return true;
      }
      return true;
    },
  };
}

export type ComparisonApi = ReturnType<typeof createComparisonApi>;
