import { resolve } from "node:path";
import { startTenSaveApplication } from "./ten-save-application.js";

const projectRoot = resolve(import.meta.dirname, "../../../..");
const portArgument = process.argv[process.argv.indexOf("--port") + 1];
const port = Number(portArgument ?? "4175");
const application = await startTenSaveApplication({ projectRoot, webRoot: resolve(projectRoot, "apps/web/dist"), port });
process.stdout.write(`${JSON.stringify({ event: "remo.vs001.ten-save.ready", origin: application.origin })}\n`);
const close = (): void => { void application.close().then(() => { process.exitCode = 0; }); };
process.once("SIGINT", close);
process.once("SIGTERM", close);
