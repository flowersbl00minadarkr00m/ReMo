import type { IncomingMessage, ServerResponse } from "node:http";
import { assertHistoryPage, projectMediaAdjustedHistoryAnchor, type HistoryReader } from "@remo/domain";
import { safelyAvailableEvidenceMedia, type EvidenceMediaAuthorityReader } from "../evidence-media/handler.js";

export const HISTORY_ROUTE_PATH = "/api/history" as const;
const CAPTURE_AUTHORITY_URL = "http://127.0.0.1:4173/fixture/save-point";

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }).end(JSON.stringify(body));
}

export function createHistoryApi(reader: HistoryReader): { readonly handle: (request: IncomingMessage, response: ServerResponse) => boolean } {
  return {
    handle(request, response) {
      if (request.url !== HISTORY_ROUTE_PATH) return false;
      if (request.method !== "GET") { writeJson(response, 405, { error: "history.read-only" }); return true; }
      if (request.socket.remoteAddress !== "127.0.0.1") { writeJson(response, 403, { error: "history.loopback-required" }); return true; }
      const page = assertHistoryPage(reader.listHistory(10));
      const authority = reader as Partial<EvidenceMediaAuthorityReader>;
      if (typeof authority.listCurrentDurable !== "function" || typeof authority.readEvidenceMedia !== "function") { writeJson(response, 200, page); return true; }
      const current = new Map(authority.listCurrentDurable().map((savePoint) => [savePoint.receipt.savePointId, savePoint]));
      const anchors = page.anchors.map((anchor) => {
        if (anchor.state !== "active") return projectMediaAdjustedHistoryAnchor(anchor);
        const durable = current.get(anchor.savePointId);
        if (durable === undefined || durable.receipt.turnId !== anchor.turnId) return projectMediaAdjustedHistoryAnchor(anchor);
        const available = safelyAvailableEvidenceMedia({ reader: authority as EvidenceMediaAuthorityReader, savePointId: anchor.savePointId, allowedCaptureUrl: CAPTURE_AUTHORITY_URL });
        return projectMediaAdjustedHistoryAnchor(anchor, {
          revision: durable.revision.revision,
          manifestDigest: durable.revision.manifestDigest,
          screenshotAvailable: available.has("screenshot"),
          replayAvailable: available.has("rrweb"),
        });
      });
      writeJson(response, 200, assertHistoryPage({ ...page, anchors }));
      return true;
    },
  };
}
