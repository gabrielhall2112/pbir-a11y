// Self-contained HTML report — a single file with inline CSS/JS and no
// external requests, so it opens offline straight from an outputs folder.
//
// Layout follows the browser tool's results page: title block, score card
// with per-category tiles, advisory panels, page tabs, then issue cards with
// why/fix. buildSummaryHtml() renders the multi-report index page used by
// scripts/check-all.ps1 with the same look.

import {
  describeVisual,
  getTabOrderReadingOrderDebug,
  type AnalysisResult,
  type Category,
  type Issue,
  type PageReport,
} from "./rulesEngine";
import { detectCustomVisuals } from "./customVisuals";

const CATEGORY_LABELS: Record<Category, string> = {
  contrast: "Colour contrast",
  colourblind: "Colour blindness",
  altText: "Alt text",
  clutter: "Clutter",
  pageTitles: "Page titles",
  visualTitles: "Visual titles",
  axisTitles: "Axis titles",
  fontScaling: "Font scaling",
  tabOrder: "Tab order",
  targetSize: "Target size",
  other: "Other",
};

// Tiles always shown, in this order; colourblind/other only when they have issues.
const TILE_ORDER: Category[] = [
  "contrast", "altText", "clutter", "pageTitles", "visualTitles",
  "axisTitles", "fontScaling", "tabOrder", "targetSize",
];

// Simple stroke icons (24×24, currentColor), in the style of Lucide (ISC).
const ICON_PATHS: Record<string, string> = {
  contrast: '<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.12a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.55-2.5 5.55-5.55C21.97 6.01 17.46 2 12 2z"/>',
  colourblind: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  altText: '<path d="M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.42l8.7 8.7a2.43 2.43 0 0 0 3.42 0l6.58-6.58a2.43 2.43 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5"/>',
  clutter: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  pageTitles: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>',
  visualTitles: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>',
  axisTitles: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>',
  fontScaling: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  tabOrder: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/>',
  targetSize: '<path d="m9 9 5 12 1.8-5.2L21 14Z"/><path d="M7.2 2.2 8 5.1"/><path d="m5.1 8-2.9-.8"/><path d="M14 4.1 12 6"/><path d="m6 12-1.9 2"/>',
  other: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  fail: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  pass: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
};

function icon(name: string, cls = "icon"): string {
  const paths = ICON_PATHS[name] ?? ICON_PATHS.other;
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface ScoreBand {
  key: "excellent" | "attention" | "poor" | "critical";
  label: string;
  tagline: string;
}

/** Score bands: 85–100 Excellent · 65–84 Needs attention · 40–64 Poor · 0–39 Critical. */
export function scoreBand(score: number): ScoreBand {
  if (score >= 85) return { key: "excellent", label: "Excellent", tagline: "Strong accessibility - polish the remaining items." };
  if (score >= 65) return { key: "attention", label: "Needs attention", tagline: "Some barriers to fix before this is fully accessible." };
  if (score >= 40) return { key: "poor", label: "Poor", tagline: "Significant accessibility barriers - plan fixes soon." };
  return { key: "critical", label: "Critical", tagline: "Major accessibility barriers - please act." };
}

const SCALE_TEXT = "85–100 Excellent · 65–84 Needs attention · 40–64 Poor · 0–39 Critical";

const STYLES = `
:root {
  --bg: hsl(42 42% 95%); --card: #fff; --fg: hsl(268 35% 15%); --muted: hsl(217 11% 40%);
  --border: hsl(42 20% 87%); --subtle: hsl(42 25% 93%); --chip: hsl(42 42% 95%);
  --header: hsl(268 35% 15%); --header-fg: #fff; --accent: hsl(43 86% 56%);
  --fail: hsl(0 72% 38%); --fail-soft: hsl(0 75% 94%);
  --warn: hsl(28 90% 28%); --warn-soft: hsl(38 95% 90%); --warn-edge: hsl(28 90% 40%);
  --pass: hsl(162 70% 22%); --pass-soft: hsl(162 50% 92%);
  --info: hsl(210 90% 32%); --info-soft: hsl(210 90% 93%);
  --radius: .75rem;
  --shadow: 0 1px 2px hsl(235 22% 10% / .04), 0 8px 24px hsl(235 22% 10% / .06);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: hsl(220 40% 8%); --card: hsl(220 35% 11%); --fg: hsl(40 30% 95%); --muted: hsl(220 12% 65%);
    --border: hsl(220 25% 20%); --subtle: hsl(220 25% 16%); --chip: hsl(220 25% 18%);
    --header: hsl(220 35% 11%); --accent: hsl(43 86% 56%);
    --fail: hsl(0 70% 68%); --fail-soft: hsl(0 45% 16%);
    --warn: hsl(38 92% 62%); --warn-soft: hsl(32 50% 15%); --warn-edge: hsl(38 92% 58%);
    --pass: hsl(162 58% 55%); --pass-soft: hsl(162 40% 13%);
    --info: hsl(210 88% 68%); --info-soft: hsl(210 45% 16%);
    --shadow: none;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 Verdana, Geneva, Tahoma, "DejaVu Sans", sans-serif; }
a { color: inherit; }
.icon { width: 1.15em; height: 1.15em; flex: none; vertical-align: -.2em; }
.topbar { background: var(--header); color: var(--header-fg); }
.topbar .inner { max-width: 1200px; margin: 0 auto; padding: 14px 16px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.topbar .mark { height: 30px; padding: 0 8px; border-radius: 8px; background: var(--accent); color: hsl(268 35% 15%); display: grid; place-items: center; font-weight: 700; font-size: 13px; }
.topbar .name { font-weight: 700; letter-spacing: .02em; }
.topbar .meta { margin-left: auto; font-size: 13px; opacity: .8; }
main { max-width: 1200px; margin: 0 auto; padding: 32px 16px 64px; }
.back { display: inline-block; margin-bottom: 12px; font-size: 14px; color: var(--muted); }
h1 { font-size: clamp(1.6rem, 4vw, 2.4rem); line-height: 1.15; margin: 0; overflow-wrap: anywhere; }
.subtitle { color: var(--muted); margin: 6px 0 0; overflow-wrap: anywhere; }
.subtitle.small { font-size: 13px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 1rem; box-shadow: var(--shadow); padding: clamp(18px, 3vw, 44px); margin-top: 28px; }
.eyebrow { text-transform: uppercase; letter-spacing: .06em; font-size: 14px; color: var(--muted); margin: 0; }
.score { font-size: clamp(1.8rem, 5vw, 2.8rem); font-weight: 700; margin: 6px 0 10px; line-height: 1.15; }
.score.critical, .score.poor { color: var(--fg); }
.band-dot { display: inline-block; width: .55em; height: .55em; border-radius: 50%; margin-left: .3em; vertical-align: .15em; }
.band-excellent { background: var(--pass); } .band-attention { background: var(--accent); }
.band-poor { background: var(--warn-edge); } .band-critical { background: var(--fail); }
.tagline { color: var(--muted); font-size: 1.1rem; margin: 0 0 4px; }
.scale { font-size: 14px; color: var(--muted); margin: 0 0 4px; }
.counts { color: var(--muted); font-size: 1.05rem; margin: 0; }
hr { border: 0; border-top: 1px solid var(--border); margin: 28px 0; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 22px; }
.tile { position: relative; background: var(--chip); border: 2px solid var(--border); border-radius: var(--radius); padding: 20px 24px; }
.tile.fail { border-color: var(--fail); } .tile.warn { border-color: var(--warn-edge); }
.tile .badge { position: absolute; top: -12px; right: -12px; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; color: #fff; }
.tile.fail .badge { background: var(--fail); } .tile.warn .badge { background: var(--warn-edge); }
.tile .badge .icon { width: 18px; height: 18px; }
.tile .label { display: flex; align-items: center; gap: 10px; font-size: 1.05rem; }
.tile .num { font-size: 2.4rem; font-weight: 700; line-height: 1.1; margin-top: 14px; }
.tile .status { font-weight: 700; letter-spacing: .08em; text-transform: uppercase; font-size: 14px; }
.tile.fail .status { color: var(--fail); } .tile.warn .status { color: var(--warn); } .tile.ok .status { color: var(--pass); }
.tile .split { color: var(--muted); }
.panel { border: 1px solid var(--border); border-left: 8px solid var(--fg); border-radius: 1rem; padding: 24px clamp(16px, 3vw, 32px); margin-top: 28px; background: var(--card); }
.panel.amber { background: var(--warn-soft); border-color: var(--warn-edge); }
.panel .head { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 14px; }
.panel .head h2 { margin: 0; font-size: 1.25rem; }
.panel .body { padding-left: clamp(0px, 4vw, 46px); }
.panel h3 { font-size: .95rem; text-transform: uppercase; letter-spacing: .06em; margin: 20px 0 8px; }
.panel h4 { font-size: 1rem; margin: 22px 0 6px; }
.panel ol, .panel ul { margin: 6px 0; padding-left: 1.6em; }
.panel details summary { cursor: pointer; font-weight: 700; text-decoration: underline; margin: 8px 0; }
.pill { display: inline-flex; align-items: center; gap: 6px; background: var(--chip); border-radius: 999px; padding: 4px 12px; font-size: 13px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.panel.amber .pill { background: hsl(42 42% 95% / .7); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .9em; }
.cv-row { background: hsl(42 42% 95% / .7); border-radius: var(--radius); padding: 10px 16px; margin: 6px 0; }
@media (prefers-color-scheme: dark) { .panel.amber .pill, .cv-row { background: var(--chip); } }
.tabs { display: inline-flex; flex-wrap: wrap; gap: 4px; background: var(--subtle); border-radius: var(--radius); padding: 6px; margin-top: 40px; max-width: 100%; }
.tabs button { font: inherit; color: var(--muted); background: transparent; border: 0; border-radius: .6rem; padding: 8px 16px; cursor: pointer; display: inline-flex; align-items: center; gap: 10px; }
.tabs button[aria-pressed="true"] { background: var(--bg); color: var(--fg); box-shadow: var(--shadow); }
.tabs button:focus-visible, .filters button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.tabs .count { font-size: 11px; background: var(--subtle); border-radius: 999px; padding: 2px 8px; }
.filters { display: flex; flex-wrap: wrap; gap: 8px; margin: 18px 0 0; }
.filters button { font: inherit; font-size: 14px; border: 1px solid var(--border); background: var(--card); color: var(--fg); border-radius: 999px; padding: 4px 14px; cursor: pointer; }
.filters button[aria-pressed="true"] { background: var(--fg); color: var(--bg); border-color: var(--fg); }
.issues-head h2 { margin: 0; font-size: 1.6rem; }
.issue { border-radius: 1rem; border-left: 8px solid; padding: 22px clamp(14px, 3vw, 32px); margin-top: 14px; display: flex; gap: 16px; }
.issue.fail { background: var(--fail-soft); border-color: var(--fail); }
.issue.warn { background: var(--warn-soft); border-color: var(--warn-edge); }
.issue.info { background: var(--info-soft); border-color: var(--info); }
.issue > .icon { margin-top: 6px; }
.issue.fail > .icon { color: var(--fail); } .issue.warn > .icon { color: var(--warn); } .issue.info > .icon { color: var(--info); }
.issue .content { min-width: 0; flex: 1; }
.issue .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
.issue h3 { margin: 0; font-size: 1.2rem; overflow-wrap: anywhere; }
.issue .pill { background: hsl(42 42% 95% / .85); color: var(--fg); }
@media (prefers-color-scheme: dark) { .issue .pill { background: var(--chip); } }
.issue p { margin: 10px 0 0; overflow-wrap: anywhere; }
.issue .detail { font-size: 1.05rem; }
.empty { color: var(--muted); padding: 18px 0 0; }
.notes { color: var(--muted); font-size: 14px; }
table.summary { width: 100%; border-collapse: collapse; font-size: 14px; }
.table-wrap { overflow-x: auto; }
table.summary th, table.summary td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
table.summary th { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); white-space: nowrap; }
table.summary th button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; text-transform: inherit; letter-spacing: inherit; }
table.summary td.num, table.summary th.num { text-align: right; font-variant-numeric: tabular-nums; }
table.summary .path { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.rating { display: inline-block; border-radius: 999px; padding: 2px 10px; font-size: 12px; font-weight: 700; white-space: nowrap; }
.rating.excellent { background: var(--pass-soft); color: var(--pass); }
.rating.attention { background: hsl(43 86% 56% / .2); color: var(--warn); }
.rating.poor { background: hsl(20 90% 88%); color: hsl(20 85% 30%); }
@media (prefers-color-scheme: dark) { .rating.poor { background: hsl(20 50% 18%); color: hsl(20 90% 70%); } }
.rating.critical { background: var(--fail-soft); color: var(--fail); }
.rating.error { background: var(--subtle); color: var(--muted); }
.stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 16px; }
.stat { background: var(--chip); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 20px; }
.stat .num { font-size: 2rem; font-weight: 700; line-height: 1.1; }
.stat .label { color: var(--muted); font-size: 14px; }
@media print {
  body { background: #fff; }
  .tabs, .filters { display: none; }
  .issue[hidden] { display: flex !important; }
  .card, .panel, .issue { box-shadow: none; break-inside: avoid; }
}
`;

function page(title: string, body: string, script = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLES}</style>
</head>
<body>
${body}
${script ? `<script>${script}</script>` : ""}
</body>
</html>
`;
}

function topbar(meta: string): string {
  return `<header class="topbar"><div class="inner"><span class="mark" aria-hidden="true">a11y</span><span class="name">Power BI accessibility audit</span><span class="meta">${esc(meta)}</span></div></header>`;
}

function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface HtmlReportOptions {
  /** Shown under the title, e.g. the folder that was checked. */
  sourcePath?: string;
  /** Loader notes (skipped visuals etc.). */
  warnings?: string[];
  /** Relative link back to an index page, if this report is part of a batch. */
  backLink?: string;
  generatedAt?: Date;
}

interface IssueRow {
  issue: Issue;
  pageId: string;
  pageName: string;
  location: string | null;
}

const SEVERITY_RANK: Record<string, number> = { fail: 0, warn: 1, info: 2, pass: 3 };

export function buildAccessibilityHtml(result: AnalysisResult, pages: PageReport[], opts: HtmlReportOptions = {}): string {
  const generated = formatDate(opts.generatedAt ?? new Date());
  const score = result.summary.overallScore;
  const band = scoreBand(score);

  // Category tallies from the pages actually shown (respects --page).
  const tally = new Map<Category, { fail: number; warn: number }>();
  const rows: IssueRow[] = [];
  for (const p of pages) {
    const add = (issue: Issue, location: string | null) => {
      if (issue.severity === "pass") return;
      rows.push({ issue, pageId: p.page.id, pageName: p.page.displayName, location });
      const t = tally.get(issue.category) ?? { fail: 0, warn: 0 };
      if (issue.severity === "fail") t.fail++;
      else if (issue.severity === "warn") t.warn++;
      tally.set(issue.category, t);
    };
    p.issues.forEach((i) => add(i, null));
    p.visuals.forEach((v) => v.issues.forEach((i) => add(i, describeVisual(v.visual))));
  }
  rows.sort((a, b) => (SEVERITY_RANK[a.issue.severity] ?? 9) - (SEVERITY_RANK[b.issue.severity] ?? 9));

  const failCount = rows.filter((r) => r.issue.severity === "fail").length;
  const warnCount = rows.filter((r) => r.issue.severity === "warn").length;
  const visualCount = pages.reduce((n, p) => n + p.visuals.length, 0);

  // ---- Score card + tiles ----
  const tileCats = [...TILE_ORDER, ...(["colourblind", "other"] as Category[]).filter((c) => tally.has(c))];
  const tiles = tileCats.map((cat) => {
    const t = tally.get(cat) ?? { fail: 0, warn: 0 };
    const state = t.fail > 0 ? "fail" : t.warn > 0 ? "warn" : "ok";
    const status = state === "fail" ? "Fail" : state === "warn" ? "Warning" : "All pass";
    const badge = state === "ok" ? "" : `<span class="badge" aria-hidden="true">${icon(state === "fail" ? "fail" : "warn")}</span>`;
    return `<div class="tile ${state}">${badge}
      <div class="label">${icon(cat)}${esc(CATEGORY_LABELS[cat])}</div>
      <div class="num">${t.fail + t.warn}</div>
      <div class="status">${status}</div>
      <div class="split">${t.fail} fail · ${t.warn} warn</div>
    </div>`;
  }).join("\n");

  const scoreCard = `<section class="card" aria-labelledby="score-heading">
    <p class="eyebrow" id="score-heading">Accessibility score (out of 100)</p>
    <p class="score ${band.key}">${score} / 100 - ${esc(band.label)}<span class="band-dot band-${band.key}" aria-hidden="true"></span></p>
    <p class="tagline">${esc(band.tagline)}</p>
    <p class="scale"><strong>Scale:</strong> ${SCALE_TEXT}</p>
    <p class="counts">${pages.length} page${pages.length === 1 ? "" : "s"} · ${visualCount} visual${visualCount === 1 ? "" : "s"} · ${rows.length} issue${rows.length === 1 ? "" : "s"} (${failCount} fail · ${warnCount} warn)</p>
    <hr>
    <div class="tiles">${tiles}</div>
  </section>`;

  // ---- Advisory: custom visuals ----
  const shownPageNames = new Set(pages.map((p) => p.page.displayName));
  const customHits = detectCustomVisuals({ ...result, pages }).filter((h) => shownPageNames.has(h.pageName));
  const customPanel = customHits.length === 0 ? "" : `<section class="panel amber" aria-labelledby="cv-heading">
    <div class="head">${icon("warn")}<span class="pill">Advisory · not scored</span><span class="pill">${icon("flag")}Custom visuals detected</span><h2 id="cv-heading">Custom Visuals Warning</h2></div>
    <div class="body">
      <p>This report uses one or more custom visuals. Custom visuals are not guaranteed to meet WCAG 2.2 AA requirements.</p>
      <h3>Detected custom visuals (${customHits.length})</h3>
      ${customHits.map((h) => `<div class="cv-row"><strong>${esc(h.pageName)}:</strong> <span class="mono">${esc(h.visualType)}</span></div>`).join("")}
      <h3>Please manually test</h3>
      <ul>
        <li>Keyboard navigation (Tab, Shift+Tab, Enter, Space, Arrow keys)</li>
        <li>Screen reader compatibility (labels, role exposure, meaningful names)</li>
        <li>Focus visibility and predictable focus order</li>
        <li>Interaction without mouse-only behaviours</li>
      </ul>
    </div>
  </section>`;

  // ---- Review notes: tab order vs. layout ----
  const tabNotes: string[] = [];
  for (const p of pages) {
    let debug;
    try {
      debug = getTabOrderReadingOrderDebug(p.page);
    } catch {
      continue;
    }
    if (!debug.flaggedPairs.length || !debug.expectedSeq.length) continue;
    const firstDiff = debug.expectedSeq.findIndex((v, i) => debug.actualSeq[i]?.id !== v.id);
    const items = debug.expectedSeq.map((v) => `<li>${esc(v.label)}</li>`);
    const shown = items.slice(0, 8).join("");
    const rest = items.slice(8);
    tabNotes.push(`<h4>Tab order on page "${esc(p.page.displayName)}"</h4>
      <p>The tab order does not follow the layout. Reading the layout row by row, left to right, the expected order is:</p>
      <ol>${shown}</ol>
      ${rest.length ? `<details><summary>Show the remaining ${rest.length} position${rest.length === 1 ? "" : "s"}</summary><ol start="9">${rest.join("")}</ol></details>` : ""}
      ${firstDiff >= 0 ? `<p>The first difference is at position ${firstDiff + 1}.</p>` : ""}`);
  }
  const tabPanel = tabNotes.length === 0 ? "" : `<section class="panel" aria-labelledby="tab-heading">
    <div class="head">${icon("info")}<span class="pill">Review notes · not scored</span><h2 id="tab-heading">Tab order review notes</h2></div>
    <div class="body">
      <p>Power BI tab order is nested, so each group has its own sequence. These notes are for review only. They are not findings and they do not change the score.</p>
      ${tabNotes.join("\n")}
      <p class="notes">This is based on position only. Some authors place a button first or last on purpose, which is fine.</p>
    </div>
  </section>`;

  const loaderPanel = !opts.warnings?.length ? "" : `<section class="panel" aria-labelledby="load-heading">
    <div class="head">${icon("info")}<h2 id="load-heading">Loader notes</h2></div>
    <div class="body"><ul>${opts.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>
  </section>`;

  // ---- Page tabs + issue list ----
  const pageCounts = new Map<string, number>();
  rows.forEach((r) => pageCounts.set(r.pageId, (pageCounts.get(r.pageId) ?? 0) + 1));
  const tabs = pages.length > 1 ? `<div class="tabs" role="group" aria-label="Filter issues by page">
    <button type="button" data-page="" aria-pressed="true">All pages <span class="count">${rows.length}</span></button>
    ${pages.map((p) => `<button type="button" data-page="${esc(p.page.id)}" aria-pressed="false">${esc(p.page.displayName)} <span class="count">${pageCounts.get(p.page.id) ?? 0}</span></button>`).join("")}
  </div>` : "";

  const filters = rows.length ? `<div class="filters" role="group" aria-label="Filter issues by severity">
    <button type="button" data-sev="" aria-pressed="true">All (${rows.length})</button>
    <button type="button" data-sev="fail" aria-pressed="false">Failures (${failCount})</button>
    <button type="button" data-sev="warn" aria-pressed="false">Warnings (${warnCount})</button>
  </div>` : "";

  const sevLabel: Record<string, string> = { fail: "Fail", warn: "Warning", info: "Info" };
  const cards = rows.map((r) => {
    const sev = r.issue.severity;
    return `<article class="issue ${sev}" data-page="${esc(r.pageId)}" data-sev="${sev}">
      ${icon(sev === "fail" ? "fail" : sev === "warn" ? "warn" : "info")}
      <div class="content">
        <div class="meta">
          <span class="pill">${sevLabel[sev] ?? sev}</span>
          <span class="pill">${icon(r.issue.category)}${esc(CATEGORY_LABELS[r.issue.category] ?? r.issue.category)}</span>
          <h3>${esc(r.issue.title)}</h3>
          <span class="pill">Page: ${esc(r.pageName)}</span>
        </div>
        <p class="detail">${esc(r.issue.detail)}</p>
        ${r.issue.why ? `<p><strong>Why:</strong> ${esc(r.issue.why)}</p>` : ""}
        ${r.issue.fix ? `<p><strong>Fix:</strong> ${esc(r.issue.fix)}</p>` : ""}
      </div>
    </article>`;
  }).join("\n");

  const issuesSection = `${tabs}
  <section class="card issues-head" aria-labelledby="issues-heading">
    <h2 id="issues-heading">${pages.length > 1 ? `All issues across ${pages.length} pages` : "All issues"}</h2>
    <p class="subtitle" id="issues-sub">${rows.length} issue${rows.length === 1 ? "" : "s"} total. Each card shows the page (tab) where the problem was found.</p>
    ${filters}
    <div id="issue-list">${cards || `<p class="empty">${icon("pass")} No issues found for the selected checks.</p>`}</div>
    <p class="empty" id="no-match" hidden>No issues match this filter.</p>
  </section>`;

  const reportName = result.fileName.replace(/\.Report$/, "");
  const body = `${topbar(`Generated ${generated}`)}
<main>
  ${opts.backLink ? `<a class="back" href="${esc(opts.backLink)}">← All reports</a>` : ""}
  <h1>${esc(reportName)}</h1>
  <p class="subtitle">Canvas ${result.canvasWidth}×${result.canvasHeight} · min font ${result.requiredMinPt}pt</p>
  ${opts.sourcePath ? `<p class="subtitle small">${esc(opts.sourcePath)}</p>` : ""}
  ${scoreCard}
  ${customPanel}
  ${tabPanel}
  ${loaderPanel}
  ${issuesSection}
</main>`;

  const script = `
(function () {
  var page = "", sev = "";
  var cards = document.querySelectorAll(".issue");
  var none = document.getElementById("no-match");
  function apply() {
    var shown = 0;
    cards.forEach(function (c) {
      var ok = (!page || c.dataset.page === page) && (!sev || c.dataset.sev === sev);
      c.hidden = !ok; if (ok) shown++;
    });
    if (none) none.hidden = shown > 0 || cards.length === 0;
  }
  function wire(sel, attr, set) {
    document.querySelectorAll(sel).forEach(function (b) {
      b.addEventListener("click", function () {
        document.querySelectorAll(sel).forEach(function (o) { o.setAttribute("aria-pressed", String(o === b)); });
        set(b.getAttribute(attr)); apply();
      });
    });
  }
  wire(".tabs button", "data-page", function (v) { page = v; });
  wire(".filters button", "data-sev", function (v) { sev = v; });
})();`;

  return page(`${reportName} - accessibility audit`, body, script);
}

// ---------------------------------------------------------------------------
// Batch index page
// ---------------------------------------------------------------------------

export interface SummaryRow {
  [column: string]: string;
}

/** Minimal RFC 4180 CSV parser (handles quoted fields, "" escapes, CRLF). */
export function parseCsv(text: string): SummaryRow[] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { record.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      record.push(field); field = "";
      if (record.some((f) => f !== "")) records.push(record);
      record = [];
    } else field += ch;
  }
  if (field !== "" || record.length) { record.push(field); if (record.some((f) => f !== "")) records.push(record); }
  const [header, ...data] = records;
  if (!header) return [];
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

export interface SummaryHtmlOptions {
  title?: string;
  rootPath?: string;
  generatedAt?: Date;
}

/**
 * Index page for a batch run. Each row needs ReportName, Score, Issues etc.
 * (the columns written by check-all.ps1); `HtmlLink` is the relative link
 * to that report's HTML page.
 */
export function buildSummaryHtml(rows: SummaryRow[], opts: SummaryHtmlOptions = {}): string {
  const generated = formatDate(opts.generatedAt ?? new Date());
  const scored = rows.filter((r) => r.Score !== "" && !isNaN(Number(r.Score)));
  const avg = scored.length ? Math.round(scored.reduce((n, r) => n + Number(r.Score), 0) / scored.length) : null;
  const sum = (col: string) => rows.reduce((n, r) => n + (Number(r[col]) || 0), 0);
  const bandCounts = { excellent: 0, attention: 0, poor: 0, critical: 0 } as Record<ScoreBand["key"], number>;
  scored.forEach((r) => bandCounts[scoreBand(Number(r.Score)).key]++);
  const errors = rows.length - scored.length;

  const stat = (num: string | number, label: string) => `<div class="stat"><div class="num">${esc(num)}</div><div class="label">${esc(label)}</div></div>`;
  const stats = `<div class="stats">
    ${stat(rows.length, "Reports checked")}
    ${stat(avg ?? "-", "Average score")}
    ${stat(sum("Failures"), "Failures")}
    ${stat(sum("Warnings"), "Warnings")}
    ${stat(bandCounts.critical, "Critical")}
    ${stat(bandCounts.poor, "Poor")}
    ${stat(bandCounts.attention, "Needs attention")}
    ${stat(bandCounts.excellent, "Excellent")}
    ${errors ? stat(errors, "Could not be read") : ""}
  </div>`;

  const cols: { key: string; label: string; num?: boolean }[] = [
    { key: "ReportName", label: "Report" },
    { key: "Repository", label: "Repository" },
    { key: "Score", label: "Score", num: true },
    { key: "Rating", label: "Rating" },
    { key: "Pages", label: "Pages", num: true },
    { key: "Visuals", label: "Visuals", num: true },
    { key: "Issues", label: "Issues", num: true },
    { key: "Failures", label: "Failures", num: true },
    { key: "Warnings", label: "Warnings", num: true },
  ];

  const body = rows.map((r) => {
    const hasScore = r.Score !== "" && !isNaN(Number(r.Score));
    const band = hasScore ? scoreBand(Number(r.Score)) : null;
    const cells = cols.map((c) => {
      const v = r[c.key] ?? "";
      if (c.key === "ReportName") {
        const name = r.HtmlLink ? `<a href="${esc(r.HtmlLink)}">${esc(v)}</a>` : esc(v);
        return `<td data-v="${esc(v.toLowerCase())}"><strong>${name}</strong><div class="path" title="${esc(r.ReportPath ?? "")}">${esc(r.DisplayPath || r.ReportPath || "")}</div></td>`;
      }
      if (c.key === "Rating") {
        const text = band ? band.label : (r.Status || "Error");
        return `<td data-v="${hasScore ? Number(r.Score) : -1}"><span class="rating ${band ? band.key : "error"}">${esc(text)}</span></td>`;
      }
      return `<td class="${c.num ? "num" : ""}" data-v="${esc(c.num ? (v === "" ? "-1" : v) : v.toLowerCase())}">${esc(v === "" && c.num ? "-" : v)}</td>`;
    }).join("");
    return `<tr>${cells}</tr>`;
  }).join("\n");

  const html = `${topbar(`Generated ${generated}`)}
<main>
  <h1>${esc(opts.title ?? "Accessibility summary")}</h1>
  ${opts.rootPath ? `<p class="subtitle">${esc(opts.rootPath)}</p>` : ""}
  <section class="card" aria-labelledby="overview-heading">
    <p class="eyebrow" id="overview-heading">Overview</p>
    <p class="scale"><strong>Scale:</strong> ${SCALE_TEXT}</p>
    <hr>
    ${stats}
  </section>
  <section class="card" aria-labelledby="reports-heading">
    <h2 id="reports-heading" style="margin-top:0">Reports</h2>
    <p class="subtitle">Select a column heading to sort. Select a report name to open its full results.</p>
    <div class="table-wrap">
    <table class="summary">
      <thead><tr>${cols.map((c, i) => `<th class="${c.num ? "num" : ""}" aria-sort="none"><button type="button" data-col="${i}" data-num="${c.num || c.key === "Rating" ? 1 : 0}">${esc(c.label)}</button></th>`).join("")}</tr></thead>
      <tbody>${body}</tbody>
    </table>
    </div>
  </section>
</main>`;

  const script = `
(function () {
  var tbody = document.querySelector("table.summary tbody");
  var ths = document.querySelectorAll("table.summary th");
  document.querySelectorAll("table.summary th button").forEach(function (b) {
    b.addEventListener("click", function () {
      var th = b.parentElement, col = +b.dataset.col, num = b.dataset.num === "1";
      var dir = th.getAttribute("aria-sort") === "ascending" ? -1 : 1;
      ths.forEach(function (t) { t.setAttribute("aria-sort", "none"); });
      th.setAttribute("aria-sort", dir === 1 ? "ascending" : "descending");
      var rows = Array.prototype.slice.call(tbody.rows);
      rows.sort(function (a, b2) {
        var x = a.cells[col].dataset.v, y = b2.cells[col].dataset.v;
        return (num ? (+x - +y) : x.localeCompare(y)) * dir;
      });
      rows.forEach(function (r) { tbody.appendChild(r); });
    });
  });
})();`;

  return page(opts.title ?? "Accessibility summary", html, script);
}
