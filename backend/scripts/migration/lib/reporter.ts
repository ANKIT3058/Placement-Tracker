import type { CheckResult, StageResult, CheckStatus } from "../types.js";

const MAX_DETAILS = Number(process.env.MIGRATION_MAX_DETAILS || 10);

const MARK: Record<CheckStatus, string> = {
  pass: "✓", // ✓
  fail: "✗", // ✗
  skip: "–", // –
};

export const stageStatus = (checks: CheckResult[]): CheckStatus => {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.length === 0 || checks.every((check) => check.status === "skip")) {
    return "skip";
  }
  return "pass";
};

export const printStage = (result: StageResult): void => {
  console.log("");
  console.log(`── ${result.stage} ${"─".repeat(Math.max(0, 58 - result.stage.length))}`);

  if (result.error) {
    console.log(`  ${MARK.fail} ${result.error}`);
    return;
  }

  if (result.checks.length === 0) {
    console.log("  – no checks applied");
    return;
  }

  for (const check of result.checks) {
    const scanned =
      typeof check.rowsChecked === "number"
        ? ` (${check.rowsChecked.toLocaleString()} rows)`
        : "";

    console.log(`  ${MARK[check.status]} ${check.name}: ${check.summary}${scanned}`);

    if (check.status !== "fail" || !check.details?.length) continue;

    for (const detail of check.details.slice(0, MAX_DETAILS)) {
      console.log(`      ${detail}`);
    }

    if (check.details.length > MAX_DETAILS) {
      console.log(
        `      … ${check.details.length - MAX_DETAILS} more (raise MIGRATION_MAX_DETAILS to see them)`,
      );
    }
  }
};

export const printReport = (stages: StageResult[], title: string): boolean => {
  const failed = stages.some((stage) => stage.status === "fail");

  const line = "=".repeat(60);

  console.log("");
  console.log(line);
  console.log("Migration Verification Report");
  console.log(title);
  console.log(line);
  console.log("");

  for (const stage of stages) {
    const detail =
      stage.status === "fail"
        ? ` — ${stage.error ?? `${stage.checks.filter((c) => c.status === "fail").length} check(s) failed`}`
        : "";

    console.log(`  ${MARK[stage.status]} ${stage.stage}${detail}`);
  }

  console.log("");
  console.log(`Migration Status: ${failed ? "FAIL" : "PASS"}`);
  console.log(line);
  console.log("");

  return !failed;
};
