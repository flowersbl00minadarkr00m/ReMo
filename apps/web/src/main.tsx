import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { matchProductRoute, type ProductRouteId } from "@remo/domain/browser";
import { App } from "#remo-application-root";
import { ApplicationErrorBoundary } from "./ApplicationErrorBoundary.js";
import { APPLICATION_MODE } from "./application-mode.js";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) throw new Error("Application root element is missing");

const route = matchProductRoute(window.location.pathname);
const routeId = route?.id;
const routeTitles: Partial<Record<ProductRouteId, string>> = {
  "capture-active": "ReMo active turn",
  "candidate-review": "ReMo candidate review",
  "save-points": "ReMo saved results",
  "save-point-detail": "ReMo evidence detail",
  replay: "ReMo replay",
  "replay-detail": "ReMo replay",
  compare: "ReMo comparison",
};

document.title = APPLICATION_MODE === "hosted-demo"
  ? "ReMo synthetic hosted demonstration"
  : routeId === undefined ? "ReMo boundary setup" : routeTitles[routeId] ?? "ReMo boundary setup";

createRoot(root).render(
  <StrictMode>
    <ApplicationErrorBoundary>
      {APPLICATION_MODE === "hosted-demo" || route !== undefined ? <App /> : <main className="route-error" role="alert"><h1>Workflow route not found</h1><p>Open a registered ReMo workflow route to continue.</p></main>}
    </ApplicationErrorBoundary>
  </StrictMode>,
);
