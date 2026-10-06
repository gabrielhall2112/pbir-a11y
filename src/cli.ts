#!/usr/bin/env node
import { Command } from "commander";
import { registerCheckCommand } from "./commands/check";
import { registerExplainCommand } from "./commands/explain";
import { registerSummaryHtmlCommand } from "./commands/summaryHtml";

const program = new Command();

program
  .name("pbir-a11y")
  .description(
    "Accessibility checks for Power BI PBIP/PBIR projects — usable by a person during development or by an AI agent editing report JSON directly.",
  )
  .version("0.1.0");

registerCheckCommand(program);
registerExplainCommand(program);
registerSummaryHtmlCommand(program);

program.parseAsync(process.argv);
