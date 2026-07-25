/**
 * `renderHtmlReport(matrix)` — a self-contained HTML eval report.
 *
 * Turns a {@link MatrixResult} into a single dependency-free HTML string you can
 * write to disk, open in a browser, drop in a PR comment, or publish as an
 * artifact. Same philosophy as {@link formatResult}: pure function, returns a
 * string, no runtime deps. The page inlines all CSS, uses native `<details>`
 * (zero JS), and is theme-aware (light/dark) — so it renders anywhere,
 * including under a strict CSP.
 *
 * What it shows: a summary stat row, a score heatmap (one row per cell, one
 * colored column per score label), a two-score scatter (cost vs quality when
 * those labels are present), and a per-run trajectory trace (the tool-call
 * sequence + assertions + scores behind each cell).
 */

import type { EvalResult, MatrixCell, MatrixResult, ObservedToolCall, ScoreAgg } from "./types.js";

export interface HtmlReportOptions {
  readonly title?: string;
  /** Emit only `<style>` + markup (no `<!doctype>`/`<html>`/`<head>`/`<body>`) — for embedding. */
  readonly fragment?: boolean;
}

// ── formatting helpers ──────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Score-appropriate precision: token-ish magnitudes → integer, else 2dp. */
function fmtNum(v: number): string {
  return Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2);
}

/** Label a cell from its axes object: `model=gpt-4o · case=refactor`. */
function axesLabel(axes: unknown): string {
  if (axes && typeof axes === "object") {
    const parts = Object.entries(axes as Record<string, unknown>).map(
      ([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`,
    );
    if (parts.length) return parts.join(" · ");
  }
  return "default";
}

/** Green→amber→red ramp for a 0..1 score. Returns an oklch string. */
function ramp(v: number): string {
  const t = Math.max(0, Math.min(1, v));
  const hue = 25 + t * 120; // 25 (red) → 145 (green)
  return `oklch(0.62 0.14 ${hue.toFixed(0)})`;
}

interface ScoreStat {
  readonly label: string;
  readonly values: number[];
  readonly min: number;
  readonly max: number;
}

/** Collect the distinct score labels + their per-cell MEANS across the matrix. */
function scoreStats<O>(matrix: MatrixResult<O>): ScoreStat[] {
  const order: string[] = [];
  const byLabel = new Map<string, number[]>();
  for (const cell of matrix.cells) {
    for (const [label, agg] of Object.entries(cell.stats.scores)) {
      if (!byLabel.has(label)) {
        byLabel.set(label, []);
        order.push(label);
      }
      byLabel.get(label)!.push(agg.mean);
    }
  }
  return order.map((label) => {
    const values = byLabel.get(label)!;
    return { label, values, min: Math.min(...values), max: Math.max(...values) };
  });
}

/** Normalize a value to 0..1 within a label's observed [min,max] for coloring. */
function norm(v: number, stat: ScoreStat): number {
  if (stat.max === stat.min) return 1;
  return (v - stat.min) / (stat.max - stat.min);
}

function aggFor<O>(cell: MatrixCell<O>, label: string): ScoreAgg | undefined {
  return cell.stats.scores[label];
}

function findLabel(stats: ScoreStat[], re: RegExp): ScoreStat | undefined {
  return stats.find((s) => re.test(s.label));
}

// ── sections ────────────────────────────────────────────────────────────────

function summary<O>(matrix: MatrixResult<O>, stats: ScoreStat[]): string {
  const n = matrix.cells.length;
  const passed = matrix.cells.filter((c) => c.stats.passRate > 0.5).length;
  const rate = n ? Math.round((passed / n) * 100) : 0;
  const cards: Array<[string, string, string]> = [
    ["pass rate", `${rate}%`, `${passed}/${n} cells`],
    ["cells", String(n), `${matrix.elapsedMs} ms`],
  ];
  for (const s of stats) {
    const mean = s.values.reduce((a, b) => a + b, 0) / s.values.length;
    const isBig = Math.abs(mean) >= 100; // token-ish → integer
    cards.push([
      `mean ${s.label}`,
      isBig ? Math.round(mean).toLocaleString() : mean.toFixed(2),
      `n=${s.values.length}`,
    ]);
  }
  return `<div class="cards">${cards
    .map(
      ([k, v, sub]) =>
        `<div class="card"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="sub">${esc(sub)}</div></div>`,
    )
    .join("")}</div>`;
}

/** Cost-like scores are lower-is-better; invert their color ramp. */
const COST_LABEL = /token|cost|latenc|ms|duration/i;

function heatmap<O>(matrix: MatrixResult<O>, stats: ScoreStat[]): string {
  if (!stats.length) return "";
  const head = `<tr><th>run</th><th>pass</th>${stats
    .map(
      (s) =>
        `<th>${esc(s.label)}${COST_LABEL.test(s.label) ? ' <span class="muted">↓</span>' : ""}</th>`,
    )
    .join("")}</tr>`;
  const rows = matrix.cells
    .map((cell) => {
      const cells = stats
        .map((s) => {
          const agg = aggFor(cell, s.label);
          if (agg === undefined) return `<td class="heat empty">·</td>`;
          const bg = ramp(COST_LABEL.test(s.label) ? 1 - norm(agg.mean, s) : norm(agg.mean, s));
          const band = agg.n > 1 ? `<span class="sd">±${esc(fmtNum(agg.stddev))}</span>` : "";
          return `<td class="heat" style="--c:${bg}">${esc(fmtNum(agg.mean))}${band}</td>`;
        })
        .join("");
      const st = cell.stats;
      const rate = st.trials > 1 ? `${st.passed}/${st.trials}` : st.passed ? "pass" : "fail";
      const pass = `<td class="pass ${st.passRate > 0.5 ? "ok" : "bad"}">${rate}</td>`;
      return `<tr><th class="run">${esc(axesLabel(cell.axes))}</th>${pass}${cells}</tr>`;
    })
    .join("");
  return `<div class="scroll"><table class="grid">${head}${rows}</table></div>`;
}

function scatter<O>(matrix: MatrixResult<O>, stats: ScoreStat[]): string {
  const x = findLabel(stats, /token|cost|latenc|ms/i);
  const y = findLabel(stats, /quality|judge|correct|score/i) ?? stats.find((s) => s !== x);
  if (!x || !y || x === y) return "";
  const W = 520;
  const H = 300;
  const pad = 40;
  const px = (v: number): number => pad + norm(v, x) * (W - pad * 2);
  const py = (v: number): number => H - pad - norm(v, y) * (H - pad * 2);
  const pts = matrix.cells
    .map((cell) => {
      const xa = aggFor(cell, x.label);
      const ya = aggFor(cell, y.label);
      if (!xa || !ya) return "";
      const xv = xa.mean;
      const yv = ya.mean;
      const good = cell.stats.passRate > 0.5;
      return `<circle cx="${px(xv).toFixed(1)}" cy="${py(yv).toFixed(1)}" r="6" class="${good ? "pt ok" : "pt bad"}"><title>${esc(axesLabel(cell.axes))}\n${esc(x.label)}=${xv}\n${esc(y.label)}=${yv}</title></circle>`;
    })
    .join("");
  return `<div class="chart">
    <div class="chart-title">${esc(y.label)} <span class="muted">vs</span> ${esc(x.label)}</div>
    <svg viewBox="0 0 ${W} ${H}" class="scatter" role="img" aria-label="scatter of ${esc(y.label)} versus ${esc(x.label)}">
      <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" class="axis"/>
      <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${H - pad}" class="axis"/>
      <text x="${W / 2}" y="${H - 6}" class="axlabel" text-anchor="middle">${esc(x.label)} →</text>
      <text x="12" y="${H / 2}" class="axlabel" text-anchor="middle" transform="rotate(-90 12 ${H / 2})">${esc(y.label)} →</text>
      ${pts}
    </svg>
  </div>`;
}

function trace(calls: readonly ObservedToolCall[]): string {
  if (!calls.length) return `<div class="muted trace-empty">no tool calls</div>`;
  const chips = [...calls]
    .sort((a, b) => a.at - b.at)
    .map(
      (c, i) =>
        `<span class="chip ${c.outcome === "succeeded" ? "ok" : "bad"}"><span class="idx">${i + 1}</span>${esc(c.name)}</span>`,
    )
    .join('<span class="arrow">→</span>');
  return `<div class="trace">${chips}</div>`;
}

function runDetails<O>(cell: MatrixCell<O>): string {
  const st = cell.stats;
  const rep: EvalResult | undefined = cell.trials[0]; // representative trial for the trace
  const asserts = (rep?.assertions ?? [])
    .map(
      (a) =>
        `<li class="${a.passed ? "ok" : "bad"}"><span class="mk">${a.passed ? "✓" : "✗"}</span> ${esc(a.label ?? a.kind)}${a.passed ? "" : ` <span class="muted">— ${esc(a.message)}</span>`}</li>`,
    )
    .join("");
  const scores = Object.entries(st.scores)
    .map(
      ([label, a]) =>
        `<li><span class="mk muted">~</span> ${esc(label)}: <b>${esc(fmtNum(a.mean))}</b>${a.n > 1 ? ` <span class="muted">±${esc(fmtNum(a.stddev))} · n=${a.n}</span>` : ""}</li>`,
    )
    .join("");
  const rate = st.trials > 1 ? `${st.passed}/${st.trials} passed` : st.passed ? "pass" : "fail";
  const atK = st.passAtK !== undefined ? ` · pass@k ${st.passAtK.toFixed(2)}` : "";
  const mk = st.passRate > 0.5 ? "ok" : "bad";
  return `<details class="run">
    <summary><span class="dot ${mk}"></span>${esc(axesLabel(cell.axes))}<span class="ms">${rate}${atK}</span></summary>
    <div class="run-body">
      ${st.trials > 1 ? `<div class="muted repnote">trajectory shown for trial 1 of ${st.trials}</div>` : ""}
      ${rep ? trace(rep.toolCalls) : ""}
      <div class="cols">
        <ul class="asserts">${asserts || '<li class="muted">no assertions</li>'}</ul>
        <ul class="scorelist">${scores || '<li class="muted">no scores</li>'}</ul>
      </div>
    </div>
  </details>`;
}

// ── style ───────────────────────────────────────────────────────────────────

const STYLE = `
:root {
  --bg: #f6f7f9; --panel: #ffffff; --ink: #1a1d24; --muted: #626878;
  --line: #e4e7ec; --accent: oklch(0.66 0.13 195); --ok: #1f9d55; --bad: #d64550;
  --shadow: 0 1px 2px rgba(20,25,40,.05), 0 1px 8px rgba(20,25,40,.04);
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root { --bg:#0d0f14; --panel:#151820; --ink:#e6e8ec; --muted:#8b93a7;
    --line:#242833; --accent: oklch(0.72 0.13 195); --ok:#3fb35f; --bad:#e5646f;
    --shadow: 0 1px 2px rgba(0,0,0,.3), 0 2px 12px rgba(0,0,0,.25); }
}
:root[data-theme="light"] { --bg:#f6f7f9; --panel:#fff; --ink:#1a1d24; --muted:#626878;
  --line:#e4e7ec; --accent: oklch(0.66 0.13 195); --ok:#1f9d55; --bad:#d64550;
  --shadow: 0 1px 2px rgba(20,25,40,.05), 0 1px 8px rgba(20,25,40,.04); }
:root[data-theme="dark"] { --bg:#0d0f14; --panel:#151820; --ink:#e6e8ec; --muted:#8b93a7;
  --line:#242833; --accent: oklch(0.72 0.13 195); --ok:#3fb35f; --bad:#e5646f;
  --shadow: 0 1px 2px rgba(0,0,0,.3), 0 2px 12px rgba(0,0,0,.25); }

.rep { background: var(--bg); color: var(--ink); font-family: var(--sans);
  font-size: 14px; line-height: 1.5; padding: 32px 24px 64px; min-height: 100%;
  -webkit-font-smoothing: antialiased; }
.wrap { max-width: 860px; margin: 0 auto; }
.rep h1 { font-size: 20px; font-weight: 650; letter-spacing: -0.01em; margin: 0; }
.rep .eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: .08em;
  text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
.rep h2 { font-size: 12px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
  color: var(--muted); margin: 36px 0 12px; }
.rep .verdict { display:inline-flex; align-items:center; gap:7px; margin-top:10px;
  font-family: var(--mono); font-size: 13px; padding: 4px 12px; border-radius: 999px;
  border: 1px solid var(--line); background: var(--panel); }
.rep .verdict .dot { width:8px; height:8px; border-radius:50%; }
.dot.ok, .verdict.ok .dot { background: var(--ok); } .dot.bad, .verdict.bad .dot { background: var(--bad); }

.cards { display:grid; grid-template-columns: repeat(auto-fit,minmax(120px,1fr)); gap:12px; margin-top:20px; }
.card { background: var(--panel); border:1px solid var(--line); border-radius:10px;
  padding:14px 16px; box-shadow: var(--shadow); }
.card .k { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.05em; }
.card .v { font-family: var(--mono); font-size:24px; font-weight:600; font-variant-numeric: tabular-nums; margin:4px 0 2px; }
.card .sub { font-size:11px; color:var(--muted); font-variant-numeric: tabular-nums; }

.scroll { overflow-x:auto; border:1px solid var(--line); border-radius:10px; box-shadow: var(--shadow); }
table.grid { width:100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
table.grid th, table.grid td { padding: 9px 12px; text-align:center; border-bottom:1px solid var(--line);
  font-family: var(--mono); font-size:12.5px; white-space:nowrap; }
table.grid thead, table.grid tr:last-child td { border-bottom:0; }
table.grid tr th:first-child, table.grid th.run { text-align:left; color:var(--muted); font-weight:500; }
table.grid > tr:first-child th { color:var(--muted); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.04em; background:var(--panel); }
td.heat { color:#fff; font-weight:600; background: var(--c); }
td.heat .sd { display:block; font-size:9px; font-weight:400; opacity:.82; margin-top:1px; }
td.heat.empty { background:transparent; color:var(--muted); }
td.pass.ok { color: var(--ok); } td.pass.bad { color: var(--bad); }

.chart { background: var(--panel); border:1px solid var(--line); border-radius:10px;
  padding:16px; box-shadow: var(--shadow); }
.chart-title { font-family: var(--mono); font-size:12px; color:var(--ink); margin-bottom:8px; }
.scatter { width:100%; height:auto; }
.scatter .axis { stroke: var(--line); stroke-width:1; }
.scatter .axlabel { fill: var(--muted); font-family: var(--mono); font-size:11px; }
.scatter .pt { stroke: var(--panel); stroke-width:1.5; }
.scatter .pt.ok { fill: var(--ok); } .scatter .pt.bad { fill: var(--bad); }

.runs { display:flex; flex-direction:column; gap:8px; }
details.run { background: var(--panel); border:1px solid var(--line); border-radius:10px; box-shadow: var(--shadow); }
details.run summary { cursor:pointer; padding:12px 16px; display:flex; align-items:center; gap:9px;
  font-family: var(--mono); font-size:13px; list-style:none; }
details.run summary::-webkit-details-marker { display:none; }
details.run summary .ms { margin-left:auto; color:var(--muted); font-size:11px; }
.run-body { padding: 4px 16px 16px; border-top:1px solid var(--line); }
.repnote { font-size:11px; margin:12px 0 -4px; }
.trace { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin:14px 0; }
.chip { display:inline-flex; align-items:center; gap:6px; font-family:var(--mono); font-size:12px;
  padding:4px 10px 4px 5px; border-radius:999px; border:1px solid var(--line); background:var(--bg); }
.chip .idx { display:inline-grid; place-items:center; width:16px; height:16px; border-radius:50%;
  font-size:10px; color:#fff; }
.chip.ok .idx { background: var(--ok); } .chip.bad .idx { background: var(--bad); }
.chip.bad { border-color: var(--bad); }
.arrow { color: var(--muted); }
.cols { display:grid; grid-template-columns: 1fr 1fr; gap:16px 24px; }
@media (max-width:560px){ .cols{ grid-template-columns:1fr; } }
.cols ul { list-style:none; margin:0; padding:0; font-size:13px; }
.cols li { padding:3px 0; }
.cols .mk { display:inline-block; width:16px; font-family:var(--mono); }
.cols li.ok .mk { color:var(--ok); } .cols li.bad .mk { color:var(--bad); }
.scorelist b { font-family:var(--mono); font-variant-numeric: tabular-nums; }
.muted { color: var(--muted); }
`;

// ── entry ────────────────────────────────────────────────────────────────────

/**
 * Render a {@link MatrixResult} as a self-contained HTML report string.
 * `opts.fragment` emits just `<style>` + markup (for embedding in a host that
 * supplies the document skeleton).
 */
export function renderHtmlReport<O>(matrix: MatrixResult<O>, opts?: HtmlReportOptions): string {
  const title = opts?.title ?? "Agent eval report";
  const stats = scoreStats(matrix);
  const passed = matrix.cells.filter((c) => c.stats.passRate > 0.5).length;
  const verdict = matrix.passed ? "ok" : "bad";

  const body = `<div class="rep"><div class="wrap">
    <div class="eyebrow">agentick · eval report</div>
    <h1>${esc(title)}</h1>
    <div class="verdict ${verdict}"><span class="dot"></span>${passed}/${matrix.cells.length} cells passed · ${matrix.elapsedMs}ms</div>

    ${summary(matrix, stats)}

    ${stats.length ? `<h2>Score heatmap</h2>${heatmap(matrix, stats)}` : ""}
    ${scatter(matrix, stats) ? `<h2>Cost vs quality</h2>${scatter(matrix, stats)}` : ""}

    <h2>Runs</h2>
    <div class="runs">${matrix.cells.map((c) => runDetails(c)).join("")}</div>
  </div></div>`;

  const styleTag = `<style>${STYLE}</style>`;
  if (opts?.fragment) return `<title>${esc(title)}</title>${styleTag}${body}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>${styleTag}</head><body style="margin:0">${body}</body></html>`;
}
