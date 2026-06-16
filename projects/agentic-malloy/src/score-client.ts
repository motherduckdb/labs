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

export class ScoreClient {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: ScoreResult) => void; reject: (e: Error) => void }>();
  private buffer = '';

  constructor(pythonBin = process.env.PYTHON_BIN || 'python3') {
    this.proc = spawn(pythonBin, [SIDECAR], { cwd: path.dirname(SIDECAR) });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.proc.stderr.on('data', (d) => console.error('[scorer]', d.toString().trimEnd()));
    this.proc.on('exit', (code) => {
      const err = new Error(`scoring sidecar exited (code ${code})`);
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
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
    const id = this.nextId++;
    const payload = JSON.stringify({ id, ...req });
    return new Promise<ScoreResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(payload + '\n');
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
