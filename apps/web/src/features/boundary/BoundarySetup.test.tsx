import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  VS001_BOUNDARY_CONTRACT,
  createPassingPreflightInput,
  evaluateBoundaryPreflight,
} from "../../../../service/src/boundaries/preflight.js";
import { ReMoBrand } from "../../components/brand/ReMoBrand.js";
import { BoundarySetup } from "./BoundarySetup.js";

describe("boundary setup surface", () => {
  it("starts visibly off with a disabled capture action and code-native scope", () => {
    const markup = renderToStaticMarkup(<BoundarySetup />);

    expect(markup).toContain("Capture off");
    expect(markup).toContain("Recording is off");
    expect(markup).toContain(VS001_BOUNDARY_CONTRACT.canonicalProjectPath);
    expect(markup).toContain("packages/test-fixtures/vs001-ui/src/**");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*Start bounded turn/);
    expect(markup).not.toContain("Conceptual mockup");
    expect(markup).not.toMatch(/timeline|rewind action|replay|branch/i);
  });

  it("renders canonical reason codes and specific recoveries for a blocked preflight", () => {
    const input = createPassingPreflightInput();
    input.selectorMatches[VS001_BOUNDARY_CONTRACT.captureRoot] = 2;
    input.commands.push("pnpm test:e2e");
    const result = evaluateBoundaryPreflight(input);
    const markup = renderToStaticMarkup(<BoundarySetup input={input} initialResult={result} />);

    expect(markup).toContain("selector.capture-root-ambiguous");
    expect(markup).toContain("Keep exactly one [data-remo-fixture-root] element");
    expect(markup).toContain("command.unapproved");
    expect(markup).toContain("Remove unapproved commands");
    expect(markup).toContain("Capture remains off");
  });

  it("keeps the rewind-themed mark decorative beside visible ReMo text", () => {
    const markup = renderToStaticMarkup(<ReMoBrand />);

    expect(markup).toContain("aria-hidden=\"true\"");
    expect(markup).toContain(">ReMo</span>");
    expect(markup).not.toContain("button");
    expect(markup).not.toContain("href=");
    expect(markup).not.toContain("tabindex");
  });
});
