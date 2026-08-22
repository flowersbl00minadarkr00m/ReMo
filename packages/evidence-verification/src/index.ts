import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

export interface VerificationDescriptor {
  readonly id: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface VerificationEvidence {
  readonly commandId: string;
  readonly status: "passed" | "failed";
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly outputLimited: boolean;
  readonly stdoutDigest?: string;
  readonly stderrDigest?: string;
  readonly durationMs: number;
  readonly reasonCodes: readonly string[];
}

export class VerificationBoundaryError extends Error {
  constructor(readonly reasonCode: "verification.command-not-allowlisted", message: string) {
    super(message);
    this.name = "VerificationBoundaryError";
  }
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function validateDescriptor(descriptor: VerificationDescriptor): VerificationDescriptor {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(descriptor.id)) throw new TypeError("Verification descriptor ID is invalid.");
  if (!isAbsolute(descriptor.executable)) throw new TypeError("Verification executable must be an absolute path.");
  if (!isAbsolute(descriptor.cwd)) throw new TypeError("Verification working directory must be absolute.");
  if (descriptor.args.length > 64 || descriptor.args.some((argument) => argument.length > 4_096)) throw new TypeError("Verification argument array exceeds its fixed bounds.");
  if (!Number.isSafeInteger(descriptor.timeoutMs) || descriptor.timeoutMs < 1 || descriptor.timeoutMs > 300_000) throw new TypeError("Verification timeout is outside the approved bound.");
  if (!Number.isSafeInteger(descriptor.maxOutputBytes) || descriptor.maxOutputBytes < 1 || descriptor.maxOutputBytes > 16 * 1024 * 1024) throw new TypeError("Verification output bound is outside the approved range.");
  return Object.freeze({ ...descriptor, args: Object.freeze([...descriptor.args]) });
}

interface ExecutionError extends Error {
  readonly code?: string | number | null;
  readonly signal?: string | null;
  readonly killed?: boolean;
  readonly stdout?: string;
  readonly stderr?: string;
}

export function createVerificationRunner(descriptors: readonly VerificationDescriptor[]): {
  run(commandId: string): Promise<VerificationEvidence>;
  descriptors(): readonly Omit<VerificationDescriptor, "executable" | "args" | "cwd">[];
} {
  const allowlist = new Map<string, VerificationDescriptor>();
  for (const input of descriptors) {
    const descriptor = validateDescriptor(input);
    if (allowlist.has(descriptor.id)) throw new TypeError(`Duplicate verification descriptor: ${descriptor.id}`);
    allowlist.set(descriptor.id, descriptor);
  }

  return {
    run(commandId) {
      const descriptor = allowlist.get(commandId);
      if (descriptor === undefined) {
        return Promise.reject(new VerificationBoundaryError("verification.command-not-allowlisted", "Only a fixed allowlisted verification descriptor may execute."));
      }
      const startedAt = performance.now();
      return new Promise((resolve) => {
        execFile(descriptor.executable, [...descriptor.args], {
          cwd: descriptor.cwd,
          timeout: descriptor.timeoutMs,
          maxBuffer: descriptor.maxOutputBytes,
          shell: false,
          windowsHide: true,
          encoding: "utf8",
        }, (error, stdout, stderr) => {
          const executionError = error as ExecutionError | null;
          const outputLimited = executionError?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || executionError?.message.includes("maxBuffer") === true;
          const timedOut = executionError?.killed === true && !outputLimited;
          const exitCode = typeof executionError?.code === "number" ? executionError.code : error === null ? 0 : null;
          const signal = executionError?.signal ?? null;
          const safeStdout = typeof stdout === "string" ? stdout : executionError?.stdout ?? "";
          const safeStderr = typeof stderr === "string" ? stderr : executionError?.stderr ?? "";
          const reasonCodes = outputLimited
            ? ["verification.output-limit"]
            : timedOut
              ? ["verification.timeout"]
              : error === null
                ? []
                : ["verification.nonzero-exit"];
          resolve({
            commandId,
            status: error === null ? "passed" : "failed",
            exitCode,
            signal,
            timedOut,
            outputLimited,
            ...(safeStdout.length === 0 ? {} : { stdoutDigest: digest(safeStdout) }),
            ...(safeStderr.length === 0 ? {} : { stderrDigest: digest(safeStderr) }),
            durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
            reasonCodes,
          });
        });
      });
    },
    descriptors() {
      return [...allowlist.values()].map(({ id, timeoutMs, maxOutputBytes }) => ({ id, timeoutMs, maxOutputBytes }));
    },
  };
}
