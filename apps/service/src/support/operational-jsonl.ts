import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { serializeDiagnosticEvent, type PayloadNeutralDiagnosticEvent } from "./diagnostic-event.js";

export const OPERATIONAL_DIAGNOSTICS_RELATIVE_PATH = ".remo/operations/vs001-operational.jsonl";
export const MAX_OPERATIONAL_DIAGNOSTICS_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;

export type DiagnosticEventInput = Omit<PayloadNeutralDiagnosticEvent, "eventId" | "occurredAt"> & {
  readonly eventId?: string;
  readonly occurredAt?: string;
};

export interface OperationalDiagnosticsReporter {
  report(event: DiagnosticEventInput): { readonly eventId: string; readonly written: boolean; readonly failureReason?: "diagnostics.write-failed" | "diagnostics.unsafe-path" };
}

export class OperationalDiagnosticsUnsafePathError extends Error {}

function contained(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function privateDirectory(path: string, controlledRoot: string): void {
  if (existsSync(path)) {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new OperationalDiagnosticsUnsafePathError("Operational diagnostics directory is unsafe.");
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const entry = lstatSync(path);
  const real = realpathSync.native(path);
  if (entry.isSymbolicLink() || !entry.isDirectory() || !contained(controlledRoot, real)) throw new OperationalDiagnosticsUnsafePathError("Operational diagnostics directory is unsafe.");
  chmodSync(path, 0o700);
}

export function inspectOperationalDiagnosticsFile(projectRoot: string, path: string): { readonly exists: boolean; readonly size: number } {
  const root = realpathSync.native(resolve(projectRoot));
  const directory = resolve(root, ".remo", "operations");
  const allowed = new Set([resolve(directory, "vs001-operational.jsonl"), resolve(directory, "vs001-operational.previous.jsonl")]);
  if (!allowed.has(resolve(path))) throw new OperationalDiagnosticsUnsafePathError("Operational diagnostics file is outside the controlled generation paths.");
  if (!existsSync(directory)) {
    const parent = resolve(directory, "..");
    const parentEntry = lstatSync(parent);
    const realParent = realpathSync.native(parent);
    if (parentEntry.isSymbolicLink() || !parentEntry.isDirectory() || !contained(root, realParent)) throw new OperationalDiagnosticsUnsafePathError("Operational diagnostics parent directory is unsafe.");
    return { exists: false, size: 0 };
  }
  const directoryEntry = lstatSync(directory);
  const realDirectory = realpathSync.native(directory);
  if (directoryEntry.isSymbolicLink() || !directoryEntry.isDirectory() || !contained(root, realDirectory)) throw new OperationalDiagnosticsUnsafePathError("Operational diagnostics directory is unsafe.");
  if (!existsSync(path)) return { exists: false, size: 0 };
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) throw new OperationalDiagnosticsUnsafePathError("Operational diagnostics file is a link, reparse point, or unexpected file type.");
  const real = realpathSync.native(path);
  if (!contained(realDirectory, real)) throw new OperationalDiagnosticsUnsafePathError("Operational diagnostics file resolves outside its controlled directory.");
  return { exists: true, size: statSync(path).size };
}

function opaqueOperationInstanceId(event: DiagnosticEventInput): string | undefined {
  if (event.operationInstanceId === undefined) return undefined;
  const domain = "remo.vs001.operational-diagnostics.operation-instance.v1\0";
  const subject = JSON.stringify({ operationId: event.operationId, turnIds: [...event.turnIds], savePointIds: [...event.savePointIds] });
  return `opi.v1.${createHash("sha256").update(domain).update(subject).update("\0").update(event.operationInstanceId).digest("hex")}`;
}

function stableEventId(event: DiagnosticEventInput): string {
  if (event.eventId !== undefined) return event.eventId;
  const identity = JSON.stringify({ operationId: event.operationId, operationInstanceId: event.operationInstanceId, turnIds: event.turnIds, savePointIds: event.savePointIds, reasonCodes: event.reasonCodes, retryCount: event.retryCount ?? 0, result: event.result });
  return `vs001.${event.operationId}.${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

export function operationalDiagnosticsPath(projectRoot: string): string {
  return resolve(projectRoot, ...OPERATIONAL_DIAGNOSTICS_RELATIVE_PATH.split("/"));
}

export function createOperationalDiagnosticsReporter(options: {
  readonly projectRoot: string;
  readonly maxBytes?: number;
  readonly now?: () => Date;
  readonly appendLine?: (path: string, line: string) => void;
}): OperationalDiagnosticsReporter {
  const path = operationalDiagnosticsPath(options.projectRoot);
  const directory = resolve(path, "..");
  const previous = join(directory, "vs001-operational.previous.jsonl");
  const maxBytes = options.maxBytes ?? MAX_OPERATIONAL_DIAGNOSTICS_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256) throw new TypeError("Operational diagnostics limit must be at least 256 bytes.");
  const appendLine = options.appendLine ?? ((target, line) => appendFileSync(target, line, { encoding: "utf8", mode: 0o600 }));
  return {
    report(input) {
      const operationInstanceId = opaqueOperationInstanceId(input);
      const event = { ...input, ...(operationInstanceId === undefined ? {} : { operationInstanceId }) };
      const eventId = stableEventId(event);
      try {
        const projectRoot = realpathSync.native(resolve(options.projectRoot));
        privateDirectory(resolve(projectRoot, ".remo"), projectRoot);
        privateDirectory(directory, projectRoot);
        const line = `${serializeDiagnosticEvent({ ...event, eventId, occurredAt: input.occurredAt ?? (options.now ?? (() => new Date()))().toISOString() })}\n`;
        const lineBytes = Buffer.byteLength(line);
        if (lineBytes > MAX_LINE_BYTES || lineBytes > maxBytes) throw new Error("Operational diagnostic event exceeds its bounded file lifecycle.");
        const current = inspectOperationalDiagnosticsFile(projectRoot, path);
        if (current.exists && current.size + lineBytes > maxBytes) {
          inspectOperationalDiagnosticsFile(projectRoot, previous);
          rmSync(previous, { force: true });
          inspectOperationalDiagnosticsFile(projectRoot, path);
          renameSync(path, previous);
          inspectOperationalDiagnosticsFile(projectRoot, previous);
          chmodSync(previous, 0o600);
        }
        inspectOperationalDiagnosticsFile(projectRoot, path);
        appendLine(path, line);
        inspectOperationalDiagnosticsFile(projectRoot, path);
        chmodSync(path, 0o600);
        return { eventId, written: true };
      } catch (error) {
        return { eventId, written: false, failureReason: error instanceof OperationalDiagnosticsUnsafePathError ? "diagnostics.unsafe-path" : "diagnostics.write-failed" };
      }
    },
  };
}

export function appendOperationalDiagnostic(path: string, event: PayloadNeutralDiagnosticEvent): Promise<void> {
  const line = `${serializeDiagnosticEvent(event)}\n`;
  appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  return Promise.resolve();
}
