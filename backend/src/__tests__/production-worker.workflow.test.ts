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

// One named step's block, from its `- name:` line up to the next step at the
// same indentation (or end of file).
//
// Scoping to a step is what makes a credential assertion mean something. A
// variable present anywhere in the file proves nothing about the process that
// needs it: the first production run failed precisely because a credential was
// absent from the step that runs the worker, and a whole-file check would be
// satisfied by the fail-fast step alone — or by a comment.
const stepNamed = (file: string, name: string): string => {
  const lines = config(file).split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);

  if (start === -1) {
    throw new Error(`No step named "${name}" in ${path.basename(file)}`);
  }

  const indent = lines[start].indexOf("- name:");
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(
    (line) => line.indexOf("- name:") === indent && line.trim().startsWith("-"),
  );

  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
};

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

  // THE ASSERTION THAT SHOULD HAVE CAUGHT THE FIRST PRODUCTION RUN.
  //
  // Its earlier form named only DATABASE_URL and REDIS_URL — the email drain's
  // two — so it passed against a workflow that could not authenticate to Gmail
  // at all. Every job failed at the OAuth token refresh with
  // `400 invalid_request`, and because per-job failures are handled by design
  // the workflow still reported success: a green run that downloaded nothing.
  //
  // Named exhaustively now, and asserted against the DRAIN STEP rather than the
  // file, so a credential that appears only in the fail-fast check above cannot
  // satisfy it. This worker needs all four; the email worker needs two, because
  // it never calls Gmail.
  test("the drain step supplies every credential the worker needs", () => {
    const drainStep = stepNamed(ATTACHMENT_WORKFLOW, "Drain the queue");

    for (const secret of [
      "DATABASE_URL",
      "REDIS_URL",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
    ]) {
      expect(drainStep).toContain(`${secret}: \${{ secrets.${secret} }}`);
    }
  });

  // The fail-fast step is what turns a missing credential into an immediate,
  // legible failure instead of one 400 per attachment, forty jobs deep, under a
  // workflow that still exits green.
  test("the credential check verifies the Gmail OAuth credentials", () => {
    const checkStep = stepNamed(
      ATTACHMENT_WORKFLOW,
      "Verify credentials are present",
    );

    for (const secret of [
      "DATABASE_URL",
      "REDIS_URL",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
    ]) {
      // Both halves: the value has to reach the step's environment, and the
      // step has to actually test it. Either alone is a check that cannot fail.
      expect(checkStep).toContain(`${secret}: \${{ secrets.${secret} }}`);
      expect(checkStep).toContain(`test -n "$${secret}"`);
    }
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

// The email drain runs AI-assisted extraction; the sibling drain still does not.
//
// `USE_AI` is read at two independent call sites — the email extraction branch
// and the Document Intelligence step — so enabling it for one queue's runtime
// says nothing about the other. That asymmetry is the contract this block pins,
// which is why the assertions here sit beside (and not instead of) the absence
// assertion the other workflow's suite already carries.
//
// ASSERTED AGAINST THE STEP, not the file, for the reason the credential test
// above records: a variable present anywhere in the workflow proves nothing
// about the process that needs it. `USE_AI` reaching the fail-fast step but not
// the drain step would leave extraction regex-only while every check passed.
describe("the email drain runs the AI-assisted extraction path", () => {
  test("the drain step enables the AI branch with the exact opt-in string", () => {
    // `extraction.service` compares against the literal "true". Any other value
    // — a missing quote, a capitalised TRUE — is silently off, and the run would
    // look identical while extracting nothing differently.
    expect(stepNamed(EMAIL_WORKFLOW, "Drain the queue")).toContain(
      "USE_AI: 'true'",
    );
  });

  test("the drain step supplies the OpenAI secret", () => {
    // Required rather than optional now: `getOpenAIClient` throws when the key
    // is absent, `extract()` catches that, and the email degrades to regex — so
    // the omission would be invisible in the run's output.
    expect(stepNamed(EMAIL_WORKFLOW, "Drain the queue")).toContain(
      "OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}",
    );
  });

  test("the drain step still supplies every credential it needed before", () => {
    // Enabling AI must not displace the two the worker cannot run without.
    const drainStep = stepNamed(EMAIL_WORKFLOW, "Drain the queue");

    for (const secret of ["DATABASE_URL", "REDIS_URL"]) {
      expect(drainStep).toContain(`${secret}: \${{ secrets.${secret} }}`);
    }
  });

  test("the credential check verifies the OpenAI key", () => {
    const checkStep = stepNamed(EMAIL_WORKFLOW, "Verify credentials are present");

    // Both halves, as in the sibling suite: the value has to reach the step's
    // environment, and the step has to actually test it. Either alone is a
    // check that cannot fail.
    expect(checkStep).toContain("OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");
    expect(checkStep).toContain('test -n "$OPENAI_API_KEY"');
  });

  test("the credential check still verifies the database and Redis", () => {
    const checkStep = stepNamed(EMAIL_WORKFLOW, "Verify credentials are present");

    for (const secret of ["DATABASE_URL", "REDIS_URL"]) {
      expect(checkStep).toContain(`${secret}: \${{ secrets.${secret} }}`);
      expect(checkStep).toContain(`test -n "$${secret}"`);
    }
  });

  test("enabling AI here does not enable it for the other queue", () => {
    // The same assertion the other suite makes, restated from this side because
    // this is the change that could plausibly have carried across. Document
    // Intelligence stays off: its gate is a separate decision about cost and
    // data egress, taken separately.
    const other = config(ATTACHMENT_WORKFLOW);

    expect(other).not.toContain("USE_AI");
    expect(other).not.toContain("OPENAI_API_KEY");
  });
});
