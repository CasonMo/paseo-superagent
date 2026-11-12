import { spawn } from "node:child_process";

export interface SourceItem {
  id: string;
  content: string;
  meta: Record<string, unknown>;
}

export interface RunResult {
  ok: boolean;
  items: SourceItem[];
  errors: string[];
  exitCode: number | null;
  stdoutBytes: number;
  stderr: string;
}

const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;

export function parseNdjson(text: string): { items: SourceItem[]; errors: string[] } {
  const items: SourceItem[] = [];
  const errors: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      errors.push(`line exceeds ${MAX_LINE_BYTES} bytes, dropped`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      errors.push(`invalid json: ${line.slice(0, 120)}`);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      errors.push("item is not an object");
      continue;
    }
    const record = parsed as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const content = typeof record.content === "string" ? record.content : "";
    if (!id) {
      errors.push("item without string id dropped");
      continue;
    }
    if (!content) {
      errors.push(`item ${id} has no content`);
      continue;
    }
    const meta = typeof record.meta === "object" && record.meta !== null && !Array.isArray(record.meta)
      ? (record.meta as Record<string, unknown>)
      : {};
    items.push({ id, content, meta });
  }
  return { items, errors };
}

export function runSourceScript(scriptPath: string, cwd: string, timeoutMs = 60_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(scriptPath, [], {
      cwd,
      detached: true,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "",
        LANG: process.env.LANG ?? "en_US.UTF-8",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const killGroup = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killGroup();
      resolve({
        ok: false,
        items: [],
        errors: [`script timed out after ${timeoutMs}ms`],
        exitCode: null,
        stdoutBytes,
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          killGroup();
          resolve({
            ok: false,
            items: [],
            errors: [`stdout exceeds ${MAX_STDOUT_BYTES} bytes`],
            exitCode: null,
            stdoutBytes,
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        }
        return;
      }
      stdout.push(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      stderrBytes += chunk.length;
      stderr.push(chunk);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        items: [],
        errors: [error.message],
        exitCode: null,
        stdoutBytes,
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const parsed = parseNdjson(Buffer.concat(stdout).toString("utf8"));
      const ok = code === 0 && parsed.items.length >= 0 && parsed.errors.length === 0;
      resolve({
        ok,
        items: parsed.items,
        errors: parsed.errors,
        exitCode: code,
        stdoutBytes,
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}
