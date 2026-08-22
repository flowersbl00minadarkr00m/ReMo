import { runTenSaveSequence, type TenSaveReport } from "./ten-save-sequence.js";
import { startLocalApplication } from "../promotion/local-application.js";

export async function startTenSaveApplication(options: { readonly projectRoot: string; readonly webRoot: string; readonly port: number }): Promise<{ readonly origin: string; readonly report: TenSaveReport; readonly close: () => Promise<void> }> {
  const report = await runTenSaveSequence(options.projectRoot);
  const application = await startLocalApplication({ projectRoot: report.projectRoot, webRoot: options.webRoot, port: options.port, seedImplementationFixture: false });
  return {
    origin: application.origin,
    report,
    async close() { await application.close(); await report.dispose(); },
  };
}
