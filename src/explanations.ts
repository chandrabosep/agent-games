import type { Explainer } from './explainer.js';
import type { AnsweredTask } from './gatekeeper.js';
import { log } from './log.js';
import type { RecentTask, Store } from './store.js';

/**
 * Explains answered Tasks one at a time in the background. Off the scoring
 * path: enqueue() returns at once, and a failing or slow explainer only
 * means a Task has no explanation.
 */
export class ExplanationQueue {
  private tail: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly store: Store,
    private readonly explainer: Explainer,
  ) {}

  enqueue(task: AnsweredTask): void {
    if (this.stopped) return;
    // setImmediate: start only after the current request has written its response.
    this.tail = this.tail.then(() => new Promise<void>((r) => setImmediate(r))).then(async () => {
      if (this.stopped) return;
      try {
        const text = await this.explainer(task);
        if (text !== null && !this.stopped) {
          this.store.setExplanation(task.taskId, text);
          log('explain.stored', { taskId: task.taskId });
        }
      } catch (e) {
        log('explain.failed', { taskId: task.taskId, error: e instanceof Error ? e.message : String(e) });
      }
    });
  }

  /** Stop taking work; waits for the Explanation in progress, but never longer than graceMs. */
  async stop(graceMs = 5_000): Promise<void> {
    this.stopped = true;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.tail, new Promise<void>((r) => (timer = setTimeout(r, graceMs)))]);
    clearTimeout(timer);
  }
}

const escapeHtml = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Task input fields each Check compares, in Check order (see src/checks.ts). */
const CHECK_FIELD_PAIRS = [
  ['registered_vk', 'proof_vk'],
  ['public_balance', 'minimum'],
  ['current_block', 'expiry_block'],
  ['recipient', 'condition_recipient'],
  ['amount', 'max_transfer'],
] as const;

export function renderExplanationsPage(tasks: RecentTask[]): string {
  const rows = tasks
    .map((t) => {
      const fields = CHECK_FIELD_PAIRS.map(
        ([a, b]) => `<div><dt>${escapeHtml(a)} / ${escapeHtml(b)}</dt><dd>${escapeHtml(t.input?.[a])} · ${escapeHtml(t.input?.[b])}</dd></div>`,
      ).join('');
      return `<article class="${t.decision === 'APPROVE' ? 'ok' : 'no'}">
  <header><span class="badge">${escapeHtml(t.decision)}</span><code>${escapeHtml(t.reasonCode)}</code><span class="meta">${escapeHtml(t.mode)} · ${escapeHtml(t.receivedAt)} · proof ${t.proofAttached ? 'attached' : 'none'}</span></header>
  <p class="why">${t.explanation ? escapeHtml(t.explanation) : '<em>No explanation yet.</em>'}</p>
  <details><summary>${escapeHtml(t.taskId)}</summary><dl>${fields}</dl></details>
</article>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gatekeeper decisions</title>
<style>
:root{--bg:#f7f7f5;--fg:#1b1b1a;--muted:#6b6b66;--card:#fff;--line:#e4e4df;--ok:#1f7a4d;--no:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#9a998f;--card:#1d1d1b;--line:#2e2e2b;--ok:#5cc28e;--no:#f2786d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px}h1{font-size:22px;margin:0 0 4px}.lede{color:var(--muted);margin:0 0 24px}
article{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--no);border-radius:8px;padding:14px 16px;margin:0 0 12px}
article.ok{border-left-color:var(--ok)}header{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}
.badge{font-weight:700;letter-spacing:.04em}.ok .badge{color:var(--ok)}.no .badge{color:var(--no)}
code{font-size:13px}.meta{color:var(--muted);font-size:13px;margin-left:auto}.why{margin:8px 0}
details{color:var(--muted);font-size:13px}dl{margin:8px 0 0;display:grid;gap:4px}dl div{display:flex;gap:8px;flex-wrap:wrap}
dt{min-width:220px}dd{margin:0;overflow-wrap:anywhere}
</style></head>
<body><main>
<h1>Gatekeeper decisions</h1>
<p class="lede">Every decision is made by deterministic checks and proven with the official Groth16 circuit. The explanations are written afterwards by Claude and never affect the decision.</p>
${rows || '<p class="lede">No tasks answered yet.</p>'}
</main></body></html>`;
}
