import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createEvidenceMediaMount, matchEvidenceMediaRoute, type EvidenceMediaRouteHandler } from "./mount.js";

describe("T3 evidence-media mount extension seam", () => {
  it("exports an exact closed-role matcher without mounting or serving bytes", () => {
    expect(matchEvidenceMediaRoute("/api/save-points/save-1/media/screenshot")).toEqual({ savePointId: "save-1", role: "screenshot" });
    expect(matchEvidenceMediaRoute("/api/save-points/save-1/media/rrweb")).toEqual({ savePointId: "save-1", role: "rrweb" });
    expect(matchEvidenceMediaRoute("/api/save-points/save-1/media/source")).toBeUndefined();
    expect(matchEvidenceMediaRoute("/api/save-points/save-1/media/screenshot?path=C:/private")).toBeUndefined();
  });

  it("delegates only matched routes to a T3-supplied handler", async () => {
    const handle = vi.fn<EvidenceMediaRouteHandler["handle"]>(() => true);
    const mount = createEvidenceMediaMount({ handle });
    const request = { url: "/api/save-points/save-1/media/screenshot" } as IncomingMessage;
    const response = {} as ServerResponse;
    expect(await mount(request, response)).toBe(true);
    expect(handle).toHaveBeenCalledWith(request, response, { savePointId: "save-1", role: "screenshot" });
    expect(mount({ url: "/api/history" } as IncomingMessage, response)).toBe(false);
  });
});
