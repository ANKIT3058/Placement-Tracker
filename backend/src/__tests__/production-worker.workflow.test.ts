// G-7.4 — the production worker workflows, checked structurally.
//
// The attachment worker has been correct and unreachable since G-7.2: no
// production runtime started it, so attachment jobs accumulated with no
// consumer. G-7.4 closes that with a second batch-drain workflow. What makes
// that worth a test is WHERE its failures surface — a wrong entrypoint path, a
// missing WORKER_EXIT_WHEN_DRAINED, or a copied-over `email-processing`
// reference fails at manual dispatch against production Redis, minutes into a
// reviewer-gated run, and nothing in `tsc` or the rest of this suite would have
// caught it.
//
// TEXT ASSERTIONS, NOT A YAML PARSE, and deliberately. `js-yaml` is present in
// this tree only as a transitive dependency of another tool: it is not declared
// in package.json, so depending on it here would make this suite break on an
// unrelated lockfile change. Adding a parser as a direct dependency to read two
// files in one test is not a trade worth making. The assertions below are
// therefore written against exact lines the workflows contain, which is enough
// to pin the facts that matter and fails loudly if either file is reshaped.
//
// The entrypoint check is the one that carries the suite: it does not merely
// assert a string, it derives the expected compiled path from the worker source
// that must exist on disk, so a moved or renamed worker fails here rather than
// in production.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const WORKFLOWS = path.join(REPO_ROOT, ".github", "workflows");

const ATTACHMENT_WORKFLOW = path.join(
  WORKFLOWS,
  "production-attachment-worker.yml",
);
const EMAIL_WORKFLOW = path.join(WORKFLOWS, "production-worker.yml");

const read = (file: string): string => readFileSync(file, "utf8");

// The workflow with its comment lines removed.
//
// Every absence assertion below runs against THIS, not the raw text. The
// invariant in each case is about what the workflow CONFIGURES — no `USE_AI`
// key, no `tsx watch` command, no `email-processing` reference — and a comment
// explaining why something is deliberately absent must name it to be worth
// reading. Asserting over the raw file would make the file's own reasoning the
// thing that fails the test, and the cheapest way to pass would be deleting the
// explanation.
//
// Only whole-line comments are stripped: nothing in these workflows puts a `#`
// after a value, and a naive trailing-comment strip would corrupt the
// `${{ secrets.X }}` expressions.
const config = (file: string): string =>
  read(file)
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

// `tsc` emits `src/**` to `dist/src/**`, so a worker's compiled entrypoint is
// its source path with the extension swapped. Deriving it here — rather than
// writing the string twice — is what makes a moved worker a test failure.
const compiledEntrypointFor = (sourceRelativeToBackend: string): string => {
  const source = path.join(BACKEND_ROOT, sourceRelativeToBackend);

  if (!existsSync(source)) {
    throw new Error(`Worker source does not exist: ${sourceRelativeToBackend}`);
  }

  return `dist/${sourceRelativeToBackend.replace(/\.ts$/, ".js")}`;
};

describe("the attachment worker has a production runtime", () => {
  test("the workflow exists", () => {
    // The whole of G-7.4. Without this file the attachment queue has no
    // production consumer, however correct the worker itself is.
    expect(existsSync(ATTACHMENT_WORKFLOW)).toBe(true);
  });

  test("it runs the compiled attachment worker entrypoint", () => {
    const entrypoint = compiledEntrypointFor(
      "src/modules/attachment/attachment.worker.ts",
    );

    expect(entrypoint).toBe(
      "dist/src/modules/attachment/attachment.worker.js",
    );
    expect(read(ATTACHMENT_WORKFLOW)).toContain(`run: node ${entrypoint}`);
  });

  test("it does not run the dev file-watcher script", () => {
    // `npm run worker:attachment` is `tsx watch`, which never exits: it would
    // defeat batch mode and hold the runner until the timeout.
    expect(config(ATTACHMENT_WORKFLOW)).not.toContain("npm run worker:attachment");
    expect(config(ATTACHMENT_WORKFLOW)).not.toContain("tsx watch");
  });

  test("it enables batch drain with the exact opt-in string", () => {
    // The worker compares against the literal "true" (G-7.2). Any other value
    // leaves it a permanent worker, which in a runner means idling to the
    // timeout and being killed.
    expect(read(ATTACHMENT_WORKFLOW)).toContain(
      "WORKER_EXIT_WHEN_DRAINED: 'true'",
    );
  });

  test("it supplies exactly the credentials the worker needs", () => {
    const workflow = read(ATTACHMENT_WORKFLOW);

    expect(workflow).toContain("DATABASE_URL: ${{ secrets.DATABASE_URL }}");
    expect(workflow).toContain("REDIS_URL: ${{ secrets.REDIS_URL }}");
  });

  test("it is manual only — no schedule, push or pull_request trigger", () => {
    const workflow = config(ATTACHMENT_WORKFLOW);

    // This job holds production database and Redis credentials. It must never
    // run as a side effect of a commit.
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("schedule:");
    expect(workflow).not.toMatch(/^\s{2}push:/m);
    expect(workflow).not.toMatch(/^\s{2}pull_request:/m);
  });

  test("it is gated behind the reviewed production-worker environment", () => {
    expect(read(ATTACHMENT_WORKFLOW)).toContain("environment: production-worker");
  });

  test("it holds a read-only token", () => {
    expect(read(ATTACHMENT_WORKFLOW)).toContain("contents: read");
  });

  test("it does not enable AI in production", () => {
    const workflow = config(ATTACHMENT_WORKFLOW);

    // `USE_AI` is the entire gate on Document Intelligence. Turning it on is a
    // deliberate decision about cost and data egress, and must not ride along
    // with a runtime change. Asserted as an absence, because that is the
    // invariant: the omission is the behaviour.
    expect(workflow).not.toContain("USE_AI");
    expect(workflow).not.toContain("OPENAI_API_KEY");
  });
});

describe("the two drains are independent", () => {
  test("the attachment drain consumes attachment-processing, never email-processing", () => {
    const workflow = config(ATTACHMENT_WORKFLOW);

    expect(workflow).toContain("Drain attachment-processing");

    // The likeliest defect in a workflow written by copying another one, and
    // invisible until it silently drains the wrong queue under the wrong name.
    expect(workflow).not.toContain("email-processing");
    expect(workflow).not.toContain("email.worker.js");
  });

  test("each drain has its own concurrency group", () => {
    // A shared group would serialise two drains that have no reason to wait for
    // each other — different queues, different jobs.
    expect(read(ATTACHMENT_WORKFLOW)).toContain(
      "group: production-attachment-worker",
    );
    expect(read(EMAIL_WORKFLOW)).toContain("group: production-email-worker");
  });

  test("neither drain cancels a run already in progress", () => {
    // Cancelling mid-drain interrupts a job that is holding its lock, which is
    // the ungraceful stop the shutdown path exists to avoid.
    for (const workflow of [ATTACHMENT_WORKFLOW, EMAIL_WORKFLOW]) {
      expect(read(workflow)).toContain("cancel-in-progress: false");
    }
  });
});

describe("the email drain is unchanged by G-7.4", () => {
  test("it still runs the compiled email worker entrypoint", () => {
    const entrypoint = compiledEntrypointFor("src/workers/email.worker.ts");

    expect(entrypoint).toBe("dist/src/workers/email.worker.js");
    expect(read(EMAIL_WORKFLOW)).toContain(`run: node ${entrypoint}`);
  });

  test("it still drains email-processing in batch mode", () => {
    const workflow = read(EMAIL_WORKFLOW);

    expect(workflow).toContain("Drain email-processing");
    expect(workflow).toContain("WORKER_EXIT_WHEN_DRAINED: 'true'");
  });

  test("it never references the attachment worker", () => {
    // G-7.4 adds a runtime beside the email one; it does not widen it.
    expect(config(EMAIL_WORKFLOW)).not.toContain("attachment");
  });
});
