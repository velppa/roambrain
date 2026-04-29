// Adapter around `emacsclient -e <elisp>`. All elisp lives in
// `elisp/roambrain.el`; this file just bootstraps `(require 'roambrain)`
// once per client and forwards calls.

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
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
    const expr = `(condition-case err
            (progn (require 'roambrain) (json-encode "ok"))
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
   */
  async callJson<T = unknown>(callExpr: string): Promise<T> {
    const out = await this.eval(callExpr);
    const inner = JSON.parse(out.trimEnd()) as string;
    return JSON.parse(inner) as T;
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
        resolve(stdout);
      });
    });
  }

  // --- Org Roam helpers (thin wrappers over roambrain.el) ---

  async orgRoamDirectory(): Promise<string> {
    return this.callJson<string>("(roambrain-org-roam-directory)");
  }

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
}

/** Quote a JS string as an elisp string literal. */
export function elispString(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}
