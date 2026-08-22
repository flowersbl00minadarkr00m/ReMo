import { pathToFileURL } from "node:url";
import { serializeDiagnosticEvent } from "./diagnostic-event.js";
import { runSupportCommand } from "./support-command.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function langfuseProbe(): (() => Promise<boolean>) | undefined {
  const baseUrl = process.env.REMO_LANGFUSE_BASE_URL;
  const approvedHost = process.env.REMO_LANGFUSE_HOST;
  if (baseUrl === undefined || approvedHost === undefined) return undefined;
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.username !== "" || base.password !== "" || base.hostname !== approvedHost || base.search !== "" || base.hash !== "") {
    return () => Promise.resolve(false);
  }
  return async () => {
    const response = await fetch(base.origin, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(3_000) });
    return response.status < 500;
  };
}

export async function main(): Promise<number> {
  const projectRoot = argument("--project-root");
  if (projectRoot === undefined) throw new TypeError("--project-root is required");
  const probeLangfuse = langfuseProbe();
  const events = await runSupportCommand({ projectRoot, ...(probeLangfuse === undefined ? {} : { probeLangfuse }) });
  for (const event of events) process.stdout.write(`${serializeDiagnosticEvent(event)}\n`);
  return events.some(({ result }) => result === "fail") ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
