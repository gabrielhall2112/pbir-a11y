// Modular accessibility rules engine.
// Input: ParsedReport from pbixParser. Output: AnalysisResult.

import type { ParsedReport, ParsedVisual, ParsedPage } from "./pbixParser";
import { evaluateContrast } from "./contrastUtils";
import { findCollisions } from "./colourblindUtils";
import { evaluateFontSize, minFontPt } from "./fontScaling";
import { clutterIndex } from "./clutterIndex";

export type Severity = "fail" | "warn" | "pass" | "info";
export type Category =
  | "contrast"
  | "colourblind"
  | "altText"
  | "clutter"
  | "pageTitles"
  | "visualTitles"
  | "axisTitles"
  | "fontScaling"
  | "tabOrder"
  | "targetSize"
  | "other";

// Which checks the user wants to run. All true = run everything.
// `colourblind` is now a UI toggle (not an automated audit rule): when on,
// the Results page surfaces an embedded Colour-Blindness Simulator so users
// can verify a screenshot of the report alongside the audit findings.
export interface CheckSelection {
  contrast: boolean;
  colourblind: boolean;
  altText: boolean;
  clutter: boolean;
  pageTitles: boolean;
  visualTitles: boolean;
  axisTitles: boolean;
  fontScaling: boolean;
  tabOrder: boolean;
  targetSize: boolean;
  customVisuals: boolean;
}

export const ALL_CHECKS: CheckSelection = {
  contrast: true,
  // Colour-blindness is NOT an automated audit rule (PBIX colour storage
  // is too varied for a reliable static parse). When on, this surfaces the
  // embedded Colour-Blindness Simulator on the Results page.
  colourblind: true,
  altText: true,
  clutter: true,
  pageTitles: true,
  visualTitles: true,
  axisTitles: true,
  fontScaling: true,
  tabOrder: true,
  targetSize: true,
  customVisuals: true,
};

export interface Issue {
  id: string;
  category: Category;
  severity: Severity;
  title: string;
  detail: string;
  why: string;
  fix: string;
  pageId?: string;
  visualId?: string;
}

export interface VisualReport {
  visual: ParsedVisual;
  issues: Issue[];
  contrastChecks: { what: string; fg: string; bg: string; ratio: number; level: string; passAA: boolean }[];
}

export interface PageReport {
  page: ParsedPage;
  issues: Issue[];
  visuals: VisualReport[];
  clutter: ReturnType<typeof clutterIndex>;
}

export interface AnalysisResult {
  fileName: string;
  fileSize: number;
  canvasWidth: number;
  canvasHeight: number;
  requiredMinPt: number;
  /** When true, the Results page surfaces an embedded Colour-Blindness Simulator alongside the audit. */
  runCvdSimulator?: boolean;
  /** When true, the Results page surfaces the advisory Custom Visuals Warning card. */
  runCustomVisualsCheck?: boolean;
  pages: PageReport[];
  summary: {
    pageCount: number;
    visualCount: number;
    issueCount: number;
    byCategory: Record<Category, { fail: number; warn: number; pass: number }>;
    overallScore: number; // 0-100
  };
}

const PLACEHOLDER_ALT = [
  "alt text",
  "enter alt text",
  "type alt text",
  "image",
  "visual",
  "chart",
  "untitled",
];

// Map Power BI internal visual type ids to human-friendly chart names.
const FRIENDLY_TYPES: Record<string, string> = {
  barChart: "Bar chart",
  clusteredBarChart: "Clustered bar chart",
  stackedBarChart: "Stacked bar chart",
  hundredPercentStackedBarChart: "100% stacked bar chart",
  columnChart: "Column chart",
  clusteredColumnChart: "Clustered column chart",
  stackedColumnChart: "Stacked column chart",
  hundredPercentStackedColumnChart: "100% stacked column chart",
  lineChart: "Line chart",
  areaChart: "Area chart",
  stackedAreaChart: "Stacked area chart",
  lineStackedColumnComboChart: "Line + stacked column",
  lineClusteredColumnComboChart: "Line + clustered column",
  pieChart: "Pie chart",
  donutChart: "Donut chart",
  funnel: "Funnel chart",
  scatterChart: "Scatter chart",
  treemap: "Treemap",
  map: "Map",
  filledMap: "Filled map",
  shapeMap: "Shape map",
  azureMap: "Azure map",
  card: "Card",
  cardVisual: "Card",
  multiRowCard: "Multi-row card",
  cardStrip: "KPI card strip",
  kpi: "KPI",
  gauge: "Gauge",
  tableEx: "Table",
  pivotTable: "Matrix",
  matrix: "Matrix",
  slicer: "Slicer",
  advancedSlicerVisual: "Slicer",
  listSlicer: "List slicer",
  textbox: "Text box",
  text: "Text box",
  image: "Image",
  shape: "Shape",
  basicShape: "Shape",
  actionButton: "Button",
  pageNavigator: "Page navigator",
  bookmarkNavigator: "Bookmark navigator",
  decompositionTreeVisual: "Decomposition tree",
  ribbonChart: "Ribbon chart",
  waterfallChart: "Waterfall chart",
  qnaVisual: "Q&A",
};

export function friendlyType(t: string): string {
  return FRIENDLY_TYPES[t] ?? t.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim();
}

// Human-readable label for a visual. Always include the visual type, plus
// either the visible title or  -  when there is no title  -  the bound fields,
// so authors can tell apart multiple visuals of the same type. Examples:
//   `Bar chart "Sales by region"`
//   `Slicer · fields: Date[Year], Product[Category]`
//   `Card (no title, no fields)`
// Power BI's internal `name` (a GUID-like id) is intentionally NOT used  - 
// it isn't visible to authors in Power BI Desktop and adds noise.
export function describeVisual(v: ParsedVisual): string {
  const type = friendlyType(v.type);
  const title = v.titleText?.trim();
  if (title && title.length > 0) return `${type} "${title}"`;
  const fields = (v.fields ?? []).slice(0, 3);
  if (fields.length > 0) {
    const more = (v.fields?.length ?? 0) > fields.length ? ` +${(v.fields!.length - fields.length)} more` : "";
    return `${type} · fields: ${fields.join(", ")}${more}`;
  }
  return `${type} (no title, no fields)`;
}

// Type-pattern helpers used by the rules below.
function typeIs(v: ParsedVisual, ...patterns: string[]): boolean {
  const t = (v.type ?? "").toLowerCase().trim();
  return patterns.some((p) => t.includes(p));
}

// Slicers, including custom ones whose type name doesn't say "slicer"
// (e.g. the text-search filter "textFilter<guid>").
function isSlicer(v: ParsedVisual): boolean {
  return typeIs(v, "slicer", "textfilter");
}

// Text boxes, shapes, buttons, navigators and slicers: UI elements rather
// than data visuals.
function isUiControl(v: ParsedVisual): boolean {
  const t = (v.type ?? "").toLowerCase().trim();
  if (t === "shapemap") return false;
  return typeIs(v, "textbox", "shape", "button", "navigator") || isSlicer(v)
    || ["text", "label", "header"].includes(t);
}

// "Pure decoration" = a shape/textbox visual with no text inside it. These
// are visual scaffolding (dividers, background panels) and don't need alt
// text. Images are not included: they always need alt text.
function isPureDecoration(v: ParsedVisual): boolean {
  const t = (v.type ?? "").toLowerCase().trim();
  if (!t) return true;
  if (t === "shapemap") return false; // a data map, not a shape
  if (new Set(["text", "label", "header", "background"]).has(t)) return !v.hasText;
  const decorative = ["shape", "textbox"].some((p) => t.includes(p));
  return decorative && !v.hasText;
}

// UI elements (text boxes, shapes, buttons, navigators, slicers) are
// announced by screen readers through their own visible text or title, so
// alt text would only duplicate it. Charts, images and other data visuals
// aren't covered here and still need alt text.
function isSelfLabelledUi(v: ParsedVisual): boolean {
  if (!isUiControl(v)) return false;
  if (v.titleText && v.titleVisible) return true;
  // Navigators render page/bookmark names and slicers render their values
  // as text, so they always carry readable content.
  if (typeIs(v, "navigator") || isSlicer(v)) return true;
  return v.hasText;
}

// Visuals that don't take a chart-style title (shapes, buttons, nav, slicers,
// text boxes, images). Title-rule scope is narrower than alt-text scope.
// Visuals that don't take a chart-style title (pure shapes, text boxes,
// images, buttons, page/bookmark navigators). Slicers and all data charts
// DO need a visible title so users  -  and screen-reader users  -  know what
// the control filters or the chart shows.
function skipTitleCheck(v: ParsedVisual): boolean {
  return typeIs(v, "shape", "textbox", "image", "button", "navigator")
    || ["text", "label", "header", "background"].includes((v.type ?? "").toLowerCase().trim());
}

// ---- Per-visual rules ----

function altTextRule(v: ParsedVisual): Issue | null {
  // Skip pure decoration (empty shapes, textboxes, images) and UI elements
  // whose own text or title is already read by screen readers. Charts,
  // images and data visuals DO need alt text so screen reader users get an
  // equivalent of what sighted users see.
  if (isPureDecoration(v) || isSelfLabelledUi(v)) return null;
  // An image hidden from the tab order is how authors mark it decorative
  // (logos, backgrounds), so screen readers skip it anyway.
  if (typeIs(v, "image") && v.isHiddenFromTabOrder) return null;
  if (!v.altText) {
    return {
      id: `${v.id}-alt-missing`,
      category: "altText",
      severity: "fail",
      title: "Missing alt text",
      detail: `${describeVisual(v)} has no alt text.`,
      why: "Screen reader users rely on alt text to understand non-text visuals.",
      fix: "In Power BI, select the visual → Format pane → General → Alt text. Describe what the visual shows and the key insight.",
      visualId: v.id,
    };
  }
  const t = v.altText.trim().toLowerCase();
  if (t.length < 4) {
    return {
      id: `${v.id}-alt-empty`,
      category: "altText",
      severity: "fail",
      title: "Empty alt text",
      detail: `${describeVisual(v)} has alt text that is too short (${v.altText.length} chars).`,
      why: "Screen readers will announce nothing useful for very short alt text.",
      fix: "Write a descriptive sentence covering both the chart type and the insight it conveys.",
      visualId: v.id,
    };
  }
  if (PLACEHOLDER_ALT.some((p) => t === p || t.startsWith(p))) {
    return {
      id: `${v.id}-alt-placeholder`,
      category: "altText",
      severity: "fail",
      title: "Placeholder alt text",
      detail: `${describeVisual(v)} uses placeholder alt text: "${v.altText}"`,
      why: "Placeholder text gives users nothing meaningful and signals the field was skipped.",
      fix: "Replace with a concrete description of the data and trend shown.",
      visualId: v.id,
    };
  }
  return null;
}

// Visual types that do NOT get an auto-generated title from Power BI when
// the user leaves the title field blank  -  slicers and cards display nothing
// in their title bar unless the author types something. For data charts
// (bar/column/line/etc.) Power BI fills the title from the bound field, so
// an absent titleText is acceptable there.
function requiresExplicitTitleText(v: ParsedVisual): boolean {
  const t = (v.type ?? "").toLowerCase().trim();
  return [
    "slicer", "advancedslicervisual", "listslicer",
    "card", "cardvisual", "multirowcard", "kpi", "gauge",
  ].some((p) => t.includes(p));
}

function visualTitleRule(v: ParsedVisual): Issue | null {
  // Shapes, text boxes, images, buttons and navigators don't take a chart-
  // style title. Slicers and all data charts DO.
  if (skipTitleCheck(v)) return null;
  // A slicer header or card label (both on by default) names the visual,
  // so a separate title isn't needed.
  if (v.builtInLabelVisible === true) return null;
  if (!v.titleVisible) {
    return {
      id: `${v.id}-title-off`,
      category: "visualTitles",
      severity: "warn",
      title: "Visual title turned off",
      detail: `${describeVisual(v)} has its title disabled.`,
      why: "Visible titles help all users  -  and especially low-vision users  -  orient themselves on a page.",
      fix: "Format pane → Title → toggle On, and provide a short, specific title.",
      visualId: v.id,
    };
  }
  // Empty authored title string  -  flag everywhere.
  if (v.titleText != null && v.titleText.trim().length === 0) {
    return {
      id: `${v.id}-title-empty`,
      category: "visualTitles",
      severity: "warn",
      title: "Empty visual title",
      detail: `${describeVisual(v)} has its title turned on but no text.`,
      why: "An empty title bar gives sighted users nothing to read and screen readers nothing to announce.",
      fix: "Format pane → Title → type a short, specific title (for slicers, name the field being filtered).",
      visualId: v.id,
    };
  }
  // Slicers, cards, KPIs and gauges don't auto-generate a title from the
  // bound field. If no titleText was authored, there's literally no title
  // displayed  -  flag it.
  if (!v.titleText && requiresExplicitTitleText(v)) {
    return {
      id: `${v.id}-title-missing`,
      category: "visualTitles",
      severity: "warn",
      title: "Missing visual title",
      detail: `${describeVisual(v)} has no title text. Slicers and cards don't auto-generate one, so nothing is shown.`,
      why: "Without a written title, sighted users have no label and screen readers announce nothing for the visual.",
      fix: "Format pane → Title → toggle On and type a short, specific title (for slicers, name the field being filtered).",
      visualId: v.id,
    };
  }
  return null;
}

function axisTitleRule(v: ParsedVisual): Issue[] {
  if (!v.hasAxes) return [];
  const out: Issue[] = [];
  if (v.xAxisTitleVisible === false) {
    out.push({
      id: `${v.id}-x-axis-title-off`,
      category: "axisTitles",
      severity: "warn",
      title: "X-axis title turned off",
      detail: `${describeVisual(v)} has no visible X-axis title.`,
      why: "Axis titles tell readers  -  and screen-reader users  -  what the axis represents and the unit of measure.",
      fix: "Format pane → X-axis → Title → toggle On, and write a short label including the unit.",
      visualId: v.id,
    });
  }
  if (v.yAxisTitleVisible === false) {
    out.push({
      id: `${v.id}-y-axis-title-off`,
      category: "axisTitles",
      severity: "warn",
      title: "Y-axis title turned off",
      detail: `${describeVisual(v)} has no visible Y-axis title.`,
      why: "Axis titles tell readers  -  and screen-reader users  -  what the axis represents and the unit of measure.",
      fix: "Format pane → Y-axis → Title → toggle On, and write a short label including the unit.",
      visualId: v.id,
    });
  }
  return out;
}

function fontSizeRule(v: ParsedVisual, canvasW: number, canvasH: number): Issue | null {
  const required = minFontPt(canvasW, canvasH);
  const tooSmall = v.fontSizes.filter((p) => p > 0 && p < required);
  if (tooSmall.length === 0) return null;
  const min = Math.min(...tooSmall);
  return {
    id: `${v.id}-font-small`,
    category: "fontScaling",
    severity: "warn",
    title: `Font below minimum (${min}pt)`,
    detail: `${describeVisual(v)} has text at ${min}pt; minimum for this canvas is ${required}pt.`,
    why: "Below-minimum text becomes unreadable when the report is projected or viewed on larger displays.",
    fix: `Open the Format pane and bump every font size to at least ${required}pt (titles, labels, axes).`,
    visualId: v.id,
  };
}

function contrastChecksFor(v: ParsedVisual): { what: string; fg: string; bg: string; ratio: number; level: string; passAA: boolean }[] {
  const bg = v.background ?? "#FFFFFF";
  const checks: { what: string; fg: string; bg: string; ratio: number; level: string; passAA: boolean }[] = [];
  const pairs: [string, string | null, number | null][] = [
    ["Title", v.titleShown ? v.titleColor : null, v.titleFontPt],
    ["Data labels", v.labelColor, v.labelFontPt],
    ["Category labels", v.categoryColor, null],
    ["Axis labels", v.axisColor, null],
  ];
  for (const [label, fg, pt] of pairs) {
    if (!fg) continue;
    const isLarge = pt != null && pt >= 18;
    const r = evaluateContrast(fg, bg, isLarge);
    if (!r) continue;
    checks.push({ what: label, fg, bg, ratio: r.ratio, level: r.level, passAA: r.passAA });
  }
  return checks;
}

function contrastIssues(v: ParsedVisual, checks: ReturnType<typeof contrastChecksFor>): Issue[] {
  return checks
    .filter((c) => !c.passAA)
    .map<Issue>((c) => ({
      id: `${v.id}-contrast-${c.what}`,
      category: "contrast",
      severity: "fail",
      title: `Low contrast: ${c.what} (${c.ratio}:1)`,
      detail: `${c.what} colour ${c.fg} on background ${c.bg} fails WCAG AA (need ≥ 4.5:1, or 3:1 for large text).`,
      why: "Insufficient contrast makes text hard to read for users with low vision or in bright environments.",
      fix: "Pick a darker text colour (or lighter background) until contrast reaches at least 4.5:1. Try the WebAIM contrast checker.",
      visualId: v.id,
    }));
}

// Non-text contrast (WCAG 1.4.11, AA, 3:1)  -  applies to graphical objects
// needed to understand the content: data series fills/marks, and axis lines.
// We check each unique series fill colour against the visual background.
// Shapes, text boxes, images, buttons, navigators and slicers have no data
// marks: their fills are decorative panels or backgrounds behind text,
// which 1.4.11 doesn't cover (their text is checked under 1.4.3 instead).
function nonTextContrastIssues(v: ParsedVisual): Issue[] {
  if (v.isDecorative || isUiControl(v) || typeIs(v, "image")) return [];
  const bg = v.background ?? "#FFFFFF";
  const fills = Array.from(new Set(v.fillColors)).filter(Boolean);
  if (fills.length === 0) return [];
  const failing: { fg: string; ratio: number }[] = [];
  for (const fg of fills) {
    // Skip if the "fill" we picked up is actually the background itself.
    if (fg.toLowerCase() === bg.toLowerCase()) continue;
    const r = evaluateContrast(fg, bg, false);
    if (!r) continue;
    if (r.ratio < 3) failing.push({ fg, ratio: r.ratio });
  }
  if (failing.length === 0) return [];
  return failing.map<Issue>((f) => ({
    id: `${v.id}-noncontrast-${f.fg}`,
    category: "contrast",
    severity: "fail",
    title: `Low non-text contrast: ${f.fg} (${f.ratio}:1)`,
    detail: `Data colour ${f.fg} on background ${bg} fails WCAG 1.4.11 non-text contrast (need ≥ 3:1).`,
    why: "Bars, lines, points and other graphical objects must contrast at least 3:1 with their background so users with low vision can perceive them.",
    fix: "Darken the series colour (or lighten the background) until the ratio reaches 3:1. Avoid pale tints on white backgrounds.",
    visualId: v.id,
  }));
}

function colourblindIssues(v: ParsedVisual): Issue[] {
  const palette = Array.from(new Set(v.fillColors)).slice(0, 12);
  const issues: Issue[] = [];

  if (palette.length < 2) return issues;

  // Per-CVD-type pairwise collisions among the series colours. We do NOT
  // attempt a heuristic "red / amber / green" detection from the layout JSON:
  // PBIX colour storage is far too varied (theme tokens, conditional
  // formatting rules, dataPoint overrides, on-object themes) for a static
  // parse to reliably extract the *rendered* palette. Instead we surface a
  // recommendation in the UI to run the visual through the Colour Blindness
  // Simulator on a screenshot  -  the only way to verify the rendered output.
  const collisions = findCollisions(palette);
  if (collisions.length > 0) {
    const byType: Record<string, typeof collisions> = {};
    for (const c of collisions) (byType[c.type] ||= []).push(c);
    for (const [type, list] of Object.entries(byType)) {
      issues.push({
        id: `${v.id}-cvd-${type}`,
        category: "colourblind",
        severity: "warn",
        title: `Series indistinguishable for ${type}`,
        detail: `${list.length} colour pair${list.length > 1 ? "s" : ""} in ${describeVisual(v)} collide under ${type} simulation.`,
        why: "Roughly 8% of men and 0.5% of women have some form of colour blindness.",
        fix: "Use a colourblind-safe palette (Okabe-Ito, viridis), add patterns/markers, or label series directly so meaning isn't carried by hue alone.",
        visualId: v.id,
      });
    }
  }
  return issues;
}

// ---- Page rule ----

function pageTitleRule(p: ParsedPage): Issue | null {
  if (p.pageTitleVisible) return null;
  return {
    id: `${p.id}-page-title-missing`,
    category: "pageTitles",
    severity: "warn",
    title: "No visible page title",
    detail: `Page "${p.displayName}" has no text/card visual near the top acting as a page title.`,
    why: "A clear page title anchors the reader and is announced first by screen readers.",
    fix: "Add a Text box at the top of the page with the page name as a heading.",
    pageId: p.id,
  };
}

// ---- Tab order rule (WCAG 2.4.3 Focus Order) ----
// Hybrid strictness:
//  - Duplicate or non-numeric tabOrder values → Fail.
//  - Decorative shapes/images with tabOrder >= 0 (i.e. focusable) → Warn,
//    plus a "suggested decorative" hint to set them to -1.
//  - Hidden visuals are excluded from tab-order validation.
//  - Visuals with no tabOrder authored are not treated as failures; Power BI
//    can append them using its default order.
/**
 * Canonical filter for tab-order checks on a page.
 * Centralised so per-visual checks and the page-level summary always
 * operate on the same set of visuals.
 *
 * - `visible`     : visuals NOT explicitly hidden from tab order
 *                   (Selection pane → "-", i.e. `isHiddenFromTabOrder === true`).
 * - `authored`    : visible visuals that have an explicit `tabOrderIndex`.
 *                   These are the ones the author included in the Selection
 *                   pane's tab order. Visuals with `tabOrderIndex == null`
 *                   are excluded  -  Power BI will append them in default order,
 *                   but they are not part of the authored sequence and must
 *                   not influence reading-order comparisons.
 * - `unauthored`  : visible visuals with no explicit tab order.
 * - `hidden`      : visuals explicitly excluded from tab order.
 */
export interface TabOrderEligibility {
  visible: ParsedVisual[];
  authored: { v: ParsedVisual; t: number }[];
  unauthored: ParsedVisual[];
  hidden: ParsedVisual[];
}

export interface TabOrderDebugVisual {
  id: string;
  label: string;
  tabOrderIndex: number;
  x: number;
  y: number;
  height: number;
  rowIndex: number;
}

export interface TabOrderDebugRow {
  rowIndex: number;
  yStart: number;
  yEnd: number;
  visualIds: string[];
}

export interface TabOrderFlaggedPair {
  before: TabOrderDebugVisual;
  after: TabOrderDebugVisual;
}

export interface TabOrderReadingOrderDebug {
  rowTol: number;
  medianHeight: number;
  heights: number[];
  rows: TabOrderDebugRow[];
  authored: TabOrderDebugVisual[];
  expectedSeq: TabOrderDebugVisual[];
  actualSeq: TabOrderDebugVisual[];
  flaggedPairs: TabOrderFlaggedPair[];
}

export function getTabOrderEligibleVisuals(p: ParsedPage): TabOrderEligibility {
  const hidden = p.visuals.filter((v) => v.isHiddenFromTabOrder);
  const visible = p.visuals.filter((v) => !v.isHiddenFromTabOrder);
  const authored = visible
    .filter((v) => v.tabOrderIndex != null)
    .map((v) => ({ v, t: v.tabOrderIndex as number }));
  const unauthored = visible.filter((v) => v.tabOrderIndex == null);
  return { visible, authored, unauthored, hidden };
}

function visualHeight(v: ParsedVisual): number {
  const height = Number(v.height);
  if (Number.isFinite(height) && height > 0) return height;
  const legacyHeight = Number(v.h);
  return Number.isFinite(legacyHeight) && legacyHeight > 0 ? legacyHeight : 0;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const mid = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return values[mid];
  return (values[mid - 1] + values[mid]) / 2;
}

function summariseTabOrderVisual(
  entry: { v: ParsedVisual; t: number },
  rowOf: Map<string, number>,
): TabOrderDebugVisual {
  return {
    id: entry.v.id,
    label: describeVisual(entry.v),
    tabOrderIndex: entry.t,
    x: entry.v.x,
    y: entry.v.y,
    height: visualHeight(entry.v),
    rowIndex: rowOf.get(entry.v.id) ?? 0,
  };
}

function clusterTabOrderRows(
  authored: { v: ParsedVisual; t: number }[],
  rowTol: number,
): { rows: TabOrderDebugRow[]; rowOf: Map<string, number> } {
  const yValues = [...new Set(authored.map((entry) => entry.v.y).filter((value) => Number.isFinite(value)))]
    .sort((a, b) => a - b);
  const bands: Array<{ yStart: number; yEnd: number; total: number; count: number }> = [];

  for (const y of yValues) {
    const last = bands[bands.length - 1];
    if (!last) {
      bands.push({ yStart: y, yEnd: y, total: y, count: 1 });
      continue;
    }
    const centre = last.total / last.count;
    if (Math.abs(y - centre) <= rowTol) {
      last.yStart = Math.min(last.yStart, y);
      last.yEnd = Math.max(last.yEnd, y);
      last.total += y;
      last.count += 1;
    } else {
      bands.push({ yStart: y, yEnd: y, total: y, count: 1 });
    }
  }

  const rows = bands.map<TabOrderDebugRow>((band, index) => ({
    rowIndex: index + 1,
    yStart: band.yStart,
    yEnd: band.yEnd,
    visualIds: [],
  }));
  const rowOf = new Map<string, number>();

  for (const entry of authored) {
    let nearestRow = rows[0]?.rowIndex ?? 1;
    let nearestDistance = Number.POSITIVE_INFINITY;
    rows.forEach((row) => {
      const centre = (row.yStart + row.yEnd) / 2;
      const distance = Math.abs(entry.v.y - centre);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestRow = row.rowIndex;
      }
    });
    rowOf.set(entry.v.id, nearestRow);
    rows[nearestRow - 1]?.visualIds.push(entry.v.id);
  }

  for (const row of rows) {
    row.visualIds.sort((a, b) => {
      const visualA = authored.find((entry) => entry.v.id === a)?.v;
      const visualB = authored.find((entry) => entry.v.id === b)?.v;
      return (visualA?.x ?? 0) - (visualB?.x ?? 0);
    });
  }

  return { rows, rowOf };
}

export function getTabOrderReadingOrderDebug(p: ParsedPage): TabOrderReadingOrderDebug {
  const { authored } = getTabOrderEligibleVisuals(p);
  const heights = authored
    .map((entry) => visualHeight(entry.v))
    .filter((height) => height > 0)
    .sort((a, b) => a - b);
  const medianHeight = median(heights) ?? 60;
  const pageCap = p.height > 0 ? Math.max(64, p.height * 0.12) : Number.POSITIVE_INFINITY;
  const rowTol = Math.max(64, Math.min(medianHeight * 0.75, pageCap));
  const { rows, rowOf } = clusterTabOrderRows(authored, rowTol);
  const expectedEntries = [...authored].sort((a, b) => {
    const rowA = rowOf.get(a.v.id) ?? 0;
    const rowB = rowOf.get(b.v.id) ?? 0;
    if (rowA !== rowB) return rowA - rowB;
    return a.v.x - b.v.x;
  });
  const actualEntries = [...authored].sort((a, b) => a.t - b.t || a.v.x - b.v.x);
  const expectedIndexById = new Map(expectedEntries.map((entry, index) => [entry.v.id, index]));
  const flaggedPairs: TabOrderFlaggedPair[] = [];

  for (let i = 0; i < actualEntries.length; i += 1) {
    for (let j = i + 1; j < actualEntries.length; j += 1) {
      const before = actualEntries[i];
      const after = actualEntries[j];
      const beforeRow = rowOf.get(before.v.id) ?? 0;
      const afterRow = rowOf.get(after.v.id) ?? 0;
      const beforeExpectedIndex = expectedIndexById.get(before.v.id) ?? 0;
      const afterExpectedIndex = expectedIndexById.get(after.v.id) ?? 0;
      if (beforeRow > afterRow && beforeExpectedIndex > afterExpectedIndex) {
        flaggedPairs.push({
          before: summariseTabOrderVisual(before, rowOf),
          after: summariseTabOrderVisual(after, rowOf),
        });
      }
    }
  }

  return {
    rowTol,
    medianHeight,
    heights,
    rows,
    authored: authored.map((entry) => summariseTabOrderVisual(entry, rowOf)),
    expectedSeq: expectedEntries.map((entry) => summariseTabOrderVisual(entry, rowOf)),
    actualSeq: actualEntries.map((entry) => summariseTabOrderVisual(entry, rowOf)),
    flaggedPairs,
  };
}

function tabOrderRulesForPage(p: ParsedPage): Issue[] {
  const issues: Issue[] = [];
  const { authored } = getTabOrderEligibleVisuals(p);
  const decorative = p.visuals.filter((v) => v.isDecorative);

  // 1. Decorative-but-focusable suggestions. Skip when author already set -1.
  for (const v of decorative) {
    if (!v.isHiddenFromTabOrder && v.tabOrderIndex != null) {
      issues.push({
        id: `${v.id}-tab-decorative-focusable`,
        category: "tabOrder",
        severity: "warn",
        title: "Decorative element receives keyboard focus",
        detail: `${describeVisual(v)} appears decorative but has tab order ${v.tabOrderIndex}. Keyboard users will land on it with nothing to read.`,
        why: "WCAG 2.4.3  -  focus order must be meaningful. Decorative shapes shouldn't receive focus.",
        fix: "In Power BI Desktop: View → Selection Pane → Tab Order → set this element's tab order to '-' (hidden) so it's skipped.",
        pageId: p.id,
        visualId: v.id,
      });
    }
  }

  // 2. Duplicate tab order values. Each visual group has its own tab
  //    sequence, so values only clash within the same group (or top level).
  const byVal = new Map<string, { t: number; entries: typeof authored }>();
  for (const e of authored) {
    const key = `${e.v.parentGroupName ?? ""}\u0000${e.t}`;
    if (!byVal.has(key)) byVal.set(key, { t: e.t, entries: [] });
    byVal.get(key)!.entries.push(e);
  }
  for (const { t, entries: group } of byVal.values()) {
    if (group.length > 1) {
      const scope = group[0].v.parentGroupName;
      issues.push({
        id: `${p.id}-tab-duplicate-${scope ? `${scope}-` : ""}${t}`,
        category: "tabOrder",
        severity: "fail",
        title: `Duplicate tab order value (${t})`,
        detail: `${group.length} elements share tab order ${t}: ${group.map((g) => describeVisual(g.v)).join("; ")}.`,
        why: "Duplicate focus indices make keyboard navigation unpredictable  -  screen-reader users may skip or revisit the same content.",
        fix: "View → Selection Pane → Tab Order. Give each focusable element a unique position in the sequence.",
        pageId: p.id,
      });
    }
  }

  return issues;
}

// ---- Target size rule (WCAG 2.5.8, interpreted via UI measurement) ----
// Evaluates interactive elements (buttons, slicers, page/bookmark navigators,
// icon-only shapes acting as controls) against:
//   - WCAG 2.5.8 minimum (24×24 CSS px)
//   - PBIX A11y recommended usability standard (40×40 px)
// Power BI canvases are authored at 1280×720 by default; when the canvas is
// wider we apply proportional scaling (canvasWidth / 1280) so thresholds
// match the rendered size. Height is ignored: a taller page scrolls at
// fit-to-width rather than rendering everything smaller.
const BASE_CANVAS_WIDTH = 1280;
const WCAG_MIN_PX = 24;
const UX_REC_PX = 40;
const ICON_REC_PX = 60;

function isInteractiveVisual(v: ParsedVisual): boolean {
  const t = (v.type ?? "").toLowerCase().trim();
  if (!t) return false;
  if (typeIs(v, "button", "navigator") || isSlicer(v)) return true;
  // Shapes and images are only controls when a click action is switched on.
  if (typeIs(v, "shape", "image") && t !== "shapemap") return v.hasAction;
  return false;
}

function targetSizeRule(v: ParsedVisual, canvasW: number): Issue | null {
  if (!isInteractiveVisual(v)) return null;
  const w = Number(v.w) || 0;
  const h = Number(v.h) || 0;
  if (w <= 0 || h <= 0) return null;

  const t = (v.type ?? "").toLowerCase().trim();
  const isIconOnly = (t.includes("shape") || t.includes("image")) && !v.hasText;
  const slicer = isSlicer(v);

  const scale = canvasW > BASE_CANVAS_WIDTH ? canvasW / BASE_CANVAS_WIDTH : 1;
  const minThreshold = WCAG_MIN_PX * scale;
  // Icons get a larger recommended target (60×60 base); buttons/slicers/navigators keep 40×40.
  const recBase = isIconOnly ? ICON_REC_PX : UX_REC_PX;
  const uxThreshold = recBase * scale;
  const minDim = Math.min(w, h);
  if (minDim >= uxThreshold) return null;

  const failsWcag = minDim < minThreshold;
  const severity: Severity = failsWcag ? "fail" : "warn";
  const recLabel = `${recBase}×${recBase} px`;
  const wcagNote = failsWcag
    ? `Below WCAG 2.5.8 minimum (24×24 px, interpreted via UI measurement) and below the recommended ${recLabel}.`
    : `Meets WCAG 2.5.8 minimum (24×24 px, interpreted via UI measurement) but below the recommended ${recLabel}.`;
  const slicerNote = slicer
    ? " For slicers we measure the container; individual selectable items may be smaller and should also be checked."
    : "";
  const iconNote = isIconOnly
    ? " Icon-only controls without a visible label carry a higher misclick risk, so the PBIX A11y standard recommends 60×60 px."
    : "";

  const wDisp = Math.round(w);
  const hDisp = Math.round(h);
  const minRound = Math.round(minThreshold);
  const uxRound = Math.round(uxThreshold);

  return {
    id: `${v.id}-target-size`,
    category: "targetSize",
    severity,
    title: failsWcag
      ? `Interactive target below 24×24 px (${wDisp}×${hDisp})`
      : `Interactive target below recommended ${recLabel} (${wDisp}×${hDisp})`,
    detail: `${describeVisual(v)} measures ${wDisp}×${hDisp} px on a ${Math.round(canvasW)}px-wide canvas (scaled thresholds: ${minRound}px minimum, ${uxRound}px recommended).${slicerNote}${iconNote}`,
    why: `${wcagNote} Larger targets reduce misclicks for pointer, touch and assistive input users.`,
    fix: `Resize the element so both width and height are at least ${uxRound}px (${recLabel} at base 1280×720). In Power BI: select the visual → Format pane → General → Size, or drag the corner handles.`,
    visualId: v.id,
  };
}


// ---- Top-level analyze ----

export function analyze(report: ParsedReport, selection: CheckSelection = ALL_CHECKS): AnalysisResult {
  const requiredMinPt = minFontPt(report.canvasWidth, report.canvasHeight);
  const pages: PageReport[] = report.pages.map((p) => {
    const visualReports: VisualReport[] = p.visuals.map((v) => {
      const issues: Issue[] = [];
      if (selection.altText) {
        const alt = altTextRule(v);
        if (alt) issues.push(alt);
      }
      if (selection.visualTitles) {
        const title = visualTitleRule(v);
        if (title) issues.push(title);
      }
      if (selection.axisTitles) {
        issues.push(...axisTitleRule(v));
      }
      // Use the page's own canvas size when available  -  Power BI canvas
      // dimensions are per-page and drive the scaled thresholds (matches the
      // UI Layout Calculator behaviour).
      const effectiveW = Number(p.width) > 0 ? Number(p.width) : report.canvasWidth;
      const effectiveH = Number(p.height) > 0 ? Number(p.height) : report.canvasHeight;
      if (selection.fontScaling) {
        const font = fontSizeRule(v, effectiveW, effectiveH);
        if (font) issues.push(font);
      }
      const checks = selection.contrast ? contrastChecksFor(v) : [];
      if (selection.contrast) {
        issues.push(...contrastIssues(v, checks));
        issues.push(...nonTextContrastIssues(v));
      }
      if (selection.targetSize) {
        const ts = targetSizeRule(v, effectiveW);
        if (ts) issues.push(ts);
      }
      // Colour-blindness check is disabled  -  see Simulator note in UI.
      // if (selection.colourblind) issues.push(...colourblindIssues(v));
      return { visual: v, issues, contrastChecks: checks };
    });

    const pageIssues: Issue[] = [];
    if (selection.pageTitles) {
      const pt = pageTitleRule(p);
      if (pt) pageIssues.push(pt);
    }
    if (selection.tabOrder) {
      pageIssues.push(...tabOrderRulesForPage(p));
    }

    // Clutter should reflect *data visualisations* only  -  exclude shapes,
    // text/page-title boxes, images, navigation buttons and slicers, which
    // contribute decoration or controls rather than information density.
    // We match by substring on the lowercased type so we also catch variants
    // like "advancedSlicerVisual", "imageVisual", "basicShape", custom
    // visuals whose id contains "slicer", etc.
    const NON_DATA_PATTERNS = ["shape", "textbox", "image", "button", "navigator", "slicer"];
    const NON_DATA_EXACT = new Set(["text", "label", "header", "background"]);
    const isDataVisual = (v: ParsedVisual) => {
      const t = (v.type ?? "").toLowerCase().trim();
      if (!t || t === "unknown") return false;
      if (NON_DATA_EXACT.has(t)) return false;
      return !NON_DATA_PATTERNS.some((p) => t.includes(p));
    };
    const dataVisuals = p.visuals.filter(isDataVisual);
    const clutter = clutterIndex(
      p.width,
      p.height,
      dataVisuals.map((v) => ({ id: v.id, type: v.type, x: v.x, y: v.y, w: v.w, h: v.h }))
    );
    const groupedNote = clutter.groupedCardCount > 0
      ? ` (grouped ${clutter.groupedCardCount + 1} adjacent card visuals into ${clutter.groupedCardCount > 0 ? "KPI strips" : "a strip"})`
      : "";
    // Clutter is the hardest signal to judge automatically  -  designers often
    // have good reasons for dense layouts. We therefore *never* raise it as a
    // failure: it is always surfaced as a warning (or stays silent on Low) and
    // the density percentage is included so the user can decide.
    const densityPct = Math.round(clutter.density * 100);
    if (selection.clutter && clutter.score === "High") {
      pageIssues.push({
        id: `${p.id}-clutter`,
        category: "clutter",
        severity: "warn",
        title: `Page may be cluttered (density ${densityPct}%)`,
        detail: `${clutter.visualCount} data visuals, density ${densityPct}%, ${clutter.overlaps.length} overlaps${groupedNote}. This is guidance, not an error  -  you may have a deliberate reason for a dense layout.`,
        why: "Dense, overlapping pages can overwhelm working memory and make screen-reader navigation harder, but this is judgement-based.",
        fix: "Consider splitting the page, adding whitespace, or moving secondary visuals to a tooltip / drill-through page.",
        pageId: p.id,
      });
    } else if (selection.clutter && clutter.score === "Medium") {
      pageIssues.push({
        id: `${p.id}-clutter-medium`,
        category: "clutter",
        severity: "warn",
        title: `Moderate page density (${densityPct}%)`,
        detail: `${clutter.visualCount} data visuals, density ${densityPct}%${groupedNote}. Guidance only  -  review whether the layout still feels comfortable.`,
        why: "Approaching the comfortable density limit for a single page.",
        fix: "Consider whether any visuals could move to drill-through or tooltip pages.",
        pageId: p.id,
      });
    }

    return { page: p, issues: pageIssues, visuals: visualReports, clutter };
  });

  // Summary
  const byCategory: AnalysisResult["summary"]["byCategory"] = {
    contrast: { fail: 0, warn: 0, pass: 0 },
    colourblind: { fail: 0, warn: 0, pass: 0 },
    altText: { fail: 0, warn: 0, pass: 0 },
    clutter: { fail: 0, warn: 0, pass: 0 },
    pageTitles: { fail: 0, warn: 0, pass: 0 },
    visualTitles: { fail: 0, warn: 0, pass: 0 },
    axisTitles: { fail: 0, warn: 0, pass: 0 },
    fontScaling: { fail: 0, warn: 0, pass: 0 },
    tabOrder: { fail: 0, warn: 0, pass: 0 },
    targetSize: { fail: 0, warn: 0, pass: 0 },
    other: { fail: 0, warn: 0, pass: 0 },
  };

  let totalIssues = 0;
  let totalFails = 0;
  let totalWarns = 0;
  let visualCount = 0;
  for (const p of pages) {
    for (const i of p.issues) {
      if (i.severity === "fail") byCategory[i.category].fail++;
      else if (i.severity === "warn") byCategory[i.category].warn++;
      totalIssues++;
      if (i.severity === "fail") totalFails++;
      if (i.severity === "warn") totalWarns++;
    }
    for (const v of p.visuals) {
      visualCount++;
      for (const i of v.issues) {
        if (i.severity === "fail") byCategory[i.category].fail++;
        else if (i.severity === "warn") byCategory[i.category].warn++;
        totalIssues++;
        if (i.severity === "fail") totalFails++;
        if (i.severity === "warn") totalWarns++;
      }
    }
  }

  // Score: 100 minus weighted issues per visual.
  const denom = Math.max(1, visualCount);
  const penalty = (totalFails * 5 + totalWarns * 2) / denom;
  const overallScore = Math.max(0, Math.min(100, Math.round(100 - penalty * 6)));

  return {
    fileName: report.fileName,
    fileSize: report.fileSize,
    canvasWidth: report.canvasWidth,
    canvasHeight: report.canvasHeight,
    requiredMinPt,
    runCvdSimulator: !!selection.colourblind,
    runCustomVisualsCheck: !!selection.customVisuals,
    pages,
    summary: {
      pageCount: pages.length,
      visualCount,
      issueCount: totalIssues,
      byCategory,
      overallScore,
    },
  };
}
