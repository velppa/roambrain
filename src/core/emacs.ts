// Adapter around `emacsclient -e <elisp>`. All elisp lives in
// `elisp/roambrain.el`; this file just bootstraps `(require 'roambrain)`
// once per client and forwards calls.

import { spawn } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface EmacsClientOptions {
  /** Path to the emacsclient binary. Defaults to `emacsclient` on PATH. */
  binary?: string;
  /** Optional --socket-name. */
  socket?: string;
  /** Per-call timeout, ms. Default 30s. */
  timeoutMs?: number;
  /** Directory holding `roambrain.el`. Defaults to repo's `elisp/`. */
  elispDir?: string;
}

export class EmacsError extends Error {
  constructor(message: string, public stderr: string, public code: number | null) {
    super(message);
    this.name = "EmacsError";
  }
}

const DEFAULT_ELISP_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "elisp",
);

export class EmacsClient {
  private readonly binary: string;
  private readonly socket?: string;
  private readonly timeoutMs: number;
  private readonly elispDir: string;
  private initPromise?: Promise<void>;

  constructor(opts: EmacsClientOptions = {}) {
    this.binary = opts.binary ?? "emacsclient";
    this.socket = opts.socket;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.elispDir = opts.elispDir ?? DEFAULT_ELISP_DIR;
  }

  /**
   * Idempotently load `roambrain.el` into the running Emacs.
   * Throws `EmacsError` if the require fails.
   */
  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit().catch((err) => {
        // Reset so a future caller can retry after fixing the env.
        this.initPromise = undefined;
        throw err;
      });
    }
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const elispFile = resolve(this.elispDir, "roambrain.el");
    const expr = `(condition-case err
            (progn
              (unless (featurep 'roambrain)
                (load-file ${elispString(elispFile)}))
              (json-encode "ok"))
          (error (json-encode (format "ERR: %S" err))))`;
    const out = await this.evalRaw(expr);
    const result = JSON.parse(JSON.parse(out.trimEnd()) as string) as string;
    if (result !== "ok") {
      throw new EmacsError(
        `failed to (require 'roambrain) from ${this.elispDir}: ${result}`,
        "",
        null,
      );
    }
  }

  /** Evaluate `elisp` and return raw stdout (an elisp printed-form string). */
  async eval(elisp: string): Promise<string> {
    await this.init();
    return this.evalRaw(elisp);
  }

  /**
   * Evaluate `elisp` that yields a value, JSON-encode that value inside Emacs,
   * and return it parsed.
   */
  async evalJson<T = unknown>(valueExpr: string): Promise<T> {
    const out = await this.eval(`(json-encode ${valueExpr})`);
    const inner = JSON.parse(out.trimEnd()) as string;
    return JSON.parse(inner) as T;
  }

  /**
   * Call a roambrain-* function whose body already returns a JSON-encoded
   * string. Saves a redundant outer `json-encode` round-trip.
   *
   * Routes through a temp file because emacs server's chunked-print protocol
   * truncates / mis-frames outputs over ~1KB (`Unknown message: p` errors).
   */
  async callJson<T = unknown>(callExpr: string): Promise<T> {
    await this.init();
    const tmp = join(tmpdir(), `roambrain-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const wrapper = `(roambrain-write-result ${elispString(tmp)} ${elispString(callExpr)})`;
    try {
      await this.evalRaw(wrapper);
      const raw = readFileSync(tmp, "utf8");
      return JSON.parse(raw) as T;
    } finally {
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  /** Internal: spawn emacsclient without the init guard. */
  private async evalRaw(elisp: string): Promise<string> {
    const args: string[] = [];
    if (this.socket) args.push("--socket-name", this.socket);
    args.push("-e", elisp);

    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new EmacsError(`emacsclient timed out after ${this.timeoutMs}ms`, stderr, null));
      }, this.timeoutMs);

      child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
      child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new EmacsError(`emacsclient failed to spawn: ${err.message}`, stderr, null));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new EmacsError(`emacsclient exited ${code}: ${stderr.trim()}`, stderr, code));
          return;
        }
        resolve(decodeEmacsclientOutput(stdout));
      });
    });
  }

  // --- Org Roam helpers (thin wrappers over roambrain.el) ---

  async orgRoamDbLocation(): Promise<string> {
    return this.callJson<string>("(roambrain-org-roam-db-location)");
  }

  async orgRoamDbSync(): Promise<void> {
    await this.callJson<true>("(roambrain-org-roam-db-sync)");
  }

  async nodeFile(id: string): Promise<string | null> {
    const path = await this.callJson<string>(`(roambrain-node-file ${elispString(id)})`);
    return path === "" ? null : path;
  }

  async readNodeContents(id: string): Promise<string | null> {
    const text = await this.callJson<string>(
      `(roambrain-node-contents ${elispString(id)})`,
    );
    return text === "" ? null : text;
  }

  async readFile(path: string): Promise<string> {
    return this.callJson<string>(`(roambrain-read-file ${elispString(path)})`);
  }

  async addLink(fromId: string, target: string, title?: string): Promise<void> {
    const titleArg = title && title.length > 0 ? ` ${elispString(title)}` : "";
    await this.callJson<true>(
      `(roambrain-add-link ${elispString(fromId)} ${elispString(target)}${titleArg})`,
    );
  }

  async removeLink(fromId: string, target: string): Promise<void> {
    await this.callJson<true>(
      `(roambrain-remove-link ${elispString(fromId)} ${elispString(target)})`,
    );
  }
}

/** Subset of EmacsClient used for write-through link mutations. */
export interface EmacsWriter {
  addLink(fromId: string, target: string, title?: string): Promise<void>;
  removeLink(fromId: string, target: string): Promise<void>;
}

/**
 * Reverse emacsclient's terminal-safe output encoding for `-e` results.
 * Server prints via `prin1` and emacsclient encodes spaces as `&_`, newlines
 * as `&n`, hyphens as `&-`, and ampersands as `&&` before writing to stdout.
 */
function decodeEmacsclientOutput(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "&" && i + 1 < s.length) {
      const n = s[i + 1];
      if (n === "_") { out += " "; i++; continue; }
      if (n === "n") { out += "\n"; i++; continue; }
      if (n === "-") { out += "-"; i++; continue; }
      if (n === "&") { out += "&"; i++; continue; }
    }
    out += c;
  }
  return out;
}

/** Quote a JS string as an elisp string literal. */
export function elispString(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}
