import * as fs from "node:fs";
import * as nodePath from "node:path";
import type { Command } from "commander";
import { buildSummaryHtml, parseCsv } from "../lib/htmlReport";

interface SummaryHtmlOptions {
  out?: string;
  title?: string;
  root?: string;
}

export function registerSummaryHtmlCommand(program: Command): void {
  program
    .command("summary-html <csv>")
    .description(
      "Render a batch summary CSV (as written by scripts/check-all.ps1) into an HTML index page linking each report's HTML results.",
    )
    .option("--out <path>", "Where to write the page. Default: index.html next to the CSV")
    .option("--title <text>", "Page heading", "Accessibility summary")
    .option("--root <path>", "Folder that was scanned, shown under the heading")
    .action((csvPath: string, opts: SummaryHtmlOptions) => {
      try {
        const csvFull = nodePath.resolve(csvPath);
        const outPath = nodePath.resolve(opts.out ?? nodePath.join(nodePath.dirname(csvFull), "index.html"));
        const rows = parseCsv(fs.readFileSync(csvFull, "utf8"));

        // Link each row to its HTML page, relative to the index so the whole
        // folder can be moved or zipped without breaking links.
        for (const r of rows) {
          if (opts.root && r.ReportPath) {
            const rel = nodePath.relative(nodePath.resolve(opts.root), r.ReportPath);
            if (rel && !rel.startsWith("..")) r.DisplayPath = rel;
          }
          const target = r.HtmlFile;
          r.HtmlLink = target && fs.existsSync(target)
            ? nodePath.relative(nodePath.dirname(outPath), target).split(nodePath.sep).map(encodeURIComponent).join("/")
            : "";
        }

        const html = buildSummaryHtml(rows, { title: opts.title, rootPath: opts.root });
        fs.mkdirSync(nodePath.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, html, "utf8");
        console.log(`Summary page written to ${outPath}`);
      } catch (err) {
        console.error("✗ Could not build summary page:", (err as Error).message);
        process.exitCode = 2;
      }
    });
}
