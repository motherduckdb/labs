/**
 * Client to the Python scoring sidecar (scoring/score_sidecar.py). One child
 * process per evaluate run; requests are correlated by a monotonic id and
 * serialized so concurrent tasks share the one process safely.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR = path.join(REPO_ROOT, 'scoring', 'score_sidecar.py');

export interface ScoreRequest {
  rows: unknown[][] | null;
  error?: string | null;
  gold: string;
  guidelines?: string | null;
  predicted_sql?: string | null;
  hit_limit?: boolean;
}
export interface ScoreResult {
  is_correct: boolean;
  correctness: 'correct' | 'incorrect' | 'error' | 'hit_limit';
  score: number;
  match_source: string;
  reason: string | null;
  predicted_answer: string | null;
  gold_answer: string;
}

/** A scorer failure (sidecar couldn't start, exited, or stdin write failed).
 *  Thrown by score() so the per-task path can record a score_error outcome
 *  instead of letting an unhandled rejection abort the pool. */
export class ScoreClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScoreClientError';
  }
}

export class ScoreClient {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: ScoreResult) => void; reject: (e: Error) => void }>();
  private buffer = '';
  /** Set once the child can no longer serve requests (spawn error or exit). */
  private deadReason: string | null = null;

  constructor(pythonBin = process.env.PYTHON_BIN || 'python3') {
    this.proc = spawn(pythonBin, [SIDECAR], { cwd: path.dirname(SIDECAR) });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.proc.stderr.on('data', (d) => console.error('[scorer]', d.toString().trimEnd()));
    // A failed spawn (e.g. python3 missing) emits 'error', not 'exit' — mark
    // dead and reject in-flight requests so score() rejects deterministically.
    this.proc.on('error', (e) => this.markDead(`scoring sidecar failed to start: ${e.message}`));
    this.proc.on('exit', (code, signal) =>
      this.markDead(`scoring sidecar exited (code ${code}${signal ? `, signal ${signal}` : ''})`),
    );
  }

  private markDead(reason: string): void {
    if (this.deadReason === null) this.deadReason = reason;
    const err = new ScoreClientError(reason);
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let resp: { id?: number; error?: string } & Partial<ScoreResult>;
      try {
        resp = JSON.parse(line);
      } catch {
        continue;
      }
      if (resp.id == null) continue;
      const waiter = this.pending.get(resp.id);
      if (!waiter) continue;
      this.pending.delete(resp.id);
      if (resp.error) waiter.reject(new Error(resp.error));
      else waiter.resolve(resp as ScoreResult);
    }
  }

  score(req: ScoreRequest): Promise<ScoreResult> {
    // If the sidecar already died, reject immediately — don't hang on a pending
    // reply that will never come.
    if (this.deadReason !== null) return Promise.reject(new ScoreClientError(this.deadReason));
    const id = this.nextId++;
    // Defensive: never let a stray BigInt (MotherDuck returns counts as BigInt)
    // throw here and abort the whole run — rows are normalized upstream, but
    // guard anyway. Safe integers → number, larger → string.
    const payload = JSON.stringify({ id, ...req }, (_k, v) =>
      typeof v === 'bigint' ? (v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v.toString()) : v,
    );
    return new Promise<ScoreResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // A write to a closed/broken stdin pipe can throw synchronously or emit
      // an error — surface it as a ScoreClientError for the per-task path.
      try {
        this.proc.stdin.write(payload + '\n', (err) => {
          if (err) {
            this.pending.delete(id);
            reject(new ScoreClientError(`scoring sidecar write failed: ${err.message}`));
          }
        });
      } catch (e) {
        this.pending.delete(id);
        reject(new ScoreClientError(`scoring sidecar write threw: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }

  close(): void {
    try {
      this.proc.stdin.end();
    } catch {
      /* ignore */
    }
  }
}
