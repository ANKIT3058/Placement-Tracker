// `extract()` — the orchestration the AI-enabled production drain now runs.
//
// Every part this composes was already covered: `validateAIDate` by
// date-evidence.test.ts, `computeConfidence` by confidence.test.ts, the regex
// layer by email/parser.test.ts. What had no coverage at all is the function
// that SEQUENCES them — the `USE_AI` gate, the fail-soft catch, and the
// AI-over-regex merge. That is the behaviour the workflow change turned on in
// production, so it is the behaviour that needs pinning before the next drain.
//
// THE SEAM IS `structuredCompletion`, matching document-classifier.test.ts.
// Mocking there means the prompt, the model config and `NO_RETRY` are exercised
// as the real service builds them, while nothing reaches OpenAI. `RetryPolicy`
// is constructed at module load (`NO_RETRY`), so the mock must supply a
// constructible class or importing the service throws before any test runs.
//
// `ai/openai-client` is mocked ONLY to keep the OpenAI SDK out of the module
// graph. `extract()` never calls `getOpenAIClient` — `extraction.service`
// merely re-exports it for the document-intelligence extractors — so the stub
// is never invoked and stands in for no behaviour under test.
//
// This suite touches no database, no queue and no network: `extraction.service`
// imports neither Prisma nor BullMQ nor `dotenv`, so nothing here can reach
// the production connections `backend/.env` points at.

const structuredCompletion = jest.fn();

jest.mock("../../ai/index", () => ({
  structuredCompletion: (...args: unknown[]) =>
    (structuredCompletion as unknown as (...a: unknown[]) => unknown)(...args),
  RetryPolicy: class RetryPolicy {
    constructor(_options?: unknown) {}
  },
}));

jest.mock("../../ai/openai-client", () => ({
  getOpenAIClient: jest.fn(),
}));

import { extract } from "../extraction.service";
import { extractStage } from "../../email/email.parser";
import {
  EmptyResponseError,
  MalformedResponseError,
  ProviderError,
} from "../../ai/ai-errors";

// ---------------------------------------------------------------------------
// Fixtures.
//
// Synthetic, small, and shaped so the deterministic extractor produces KNOWN
// values — a test that asserts "AI won" is meaningless unless regex would
// demonstrably have produced something else.
//
// Lower-cased because that is what `extract()` actually receives: `email.service`
// passes `cleanEmail(body).toLowerCase()`, and `generateEventKey` does no
// normalisation, so casing is load-bearing downstream.
// ---------------------------------------------------------------------------

// Regex resolves every field. The precedence tests use this one, so that an AI
// value replacing a regex value is visible rather than merely filling a hole.
const FULL_EMAIL =
  "infosys is conducting an online test on 16th august 2027 at 10 am. venue: hackerrank";

const FULL_EMAIL_REGEX_RESULT = {
  company: "infosys",
  stage: "OA",
  date: "2027-08-16",
  time: "10:00",
  venue: "hackerrank",
};

// Same shape, no time — used where a partially-resolved observation matters.
const NO_TIME_EMAIL =
  "amazon is conducting an online test on 16th august 2027. venue: hackerrank";

// Two dates, company first. The leading position matters: `extractCompany`'s
// lazy pattern would otherwise swallow an earlier sentence into the company.
// The deterministic extractor takes the FIRST mention (the 16th); the AI may
// legitimately select the second (the 10th), which is what makes an accepted AI
// date distinguishable from a regex fallback.
const TWO_DATE_EMAIL =
  "amazon is conducting an interview on 16th august 2027. the registration deadline is 10th august 2027.";

// No round keyword at all, so `extractStage` returns its "unknown" placeholder
// while the company still resolves. Isolates "the AI knows something the
// patterns do not" from "the AI contradicts the patterns".
const NO_STAGE_EMAIL = "acme corp is visiting on 16th august 2027.";

// The mirror image: a round resolves, no company pattern matches, so
// `extractCompany` returns its placeholder.
const NO_COMPANY_EMAIL =
  "the placement drive will be held on 16th august 2027. online test at 10 am.";

// The shape that produced Event 76: the only "at <token>" in the body is a link,
// so the pattern layer captured the bare scheme as the company.
const URL_COMPANY_EMAIL =
  "online test on 16th august 2027. for any queries please refer to the portal at https://track.example.com/abc";

// A complete AI reply, in the shape the prompt asks for.
const aiReply = (overrides: Record<string, unknown> = {}) => ({
  company: "infosys limited",
  stage: "Interview",
  date: "2027-08-16",
  time: "14:30",
  venue: "zoom",
  ...overrides,
});

// `USE_AI` is process-wide, so it is captured once and restored after every
// test. Leaking it would silently arm or disarm the gate for whatever runs next.
const ORIGINAL_USE_AI = process.env.USE_AI;

beforeEach(() => {
  jest.clearAllMocks();

  // `extract()` narrates both its AI failures and its regex-only fallback.
  // Silenced, never asserted on: the messages are diagnostics, not a contract.
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();

  if (ORIGINAL_USE_AI === undefined) {
    delete process.env.USE_AI;
  } else {
    process.env.USE_AI = ORIGINAL_USE_AI;
  }
});

// ---------------------------------------------------------------------------
// 1. The gate.
// ---------------------------------------------------------------------------

describe("the USE_AI gate", () => {
  // The service compares against the literal string. A mistyped or
  // differently-cased value must read as OFF, not as "probably meant true" —
  // the workflow now ships `USE_AI: 'true'`, and this is what makes that exact
  // spelling load-bearing rather than incidental.
  const disabled: [string, string | undefined][] = [
    ["unset", undefined],
    ["false", "false"],
    ["TRUE", "TRUE"],
  ];

  test.each(disabled)(
    "makes no provider call when USE_AI is %s",
    async (_label, value) => {
      if (value === undefined) {
        delete process.env.USE_AI;
      } else {
        process.env.USE_AI = value;
      }

      await extract(FULL_EMAIL);

      expect(structuredCompletion).not.toHaveBeenCalled();
    },
  );

  test.each(disabled)(
    "still extracts deterministically when USE_AI is %s",
    async (_label, value) => {
      if (value === undefined) {
        delete process.env.USE_AI;
      } else {
        process.env.USE_AI = value;
      }

      const result = await extract(FULL_EMAIL);

      expect(result.data).toMatchObject(FULL_EMAIL_REGEX_RESULT);
      expect(result.status).toBe("complete");
    },
  );

  test("reaches the provider when USE_AI is exactly 'true'", async () => {
    process.env.USE_AI = "true";
    structuredCompletion.mockResolvedValue(aiReply());

    await extract(FULL_EMAIL);

    expect(structuredCompletion).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2 & 9. The enabled path, and how many attempts it makes.
// ---------------------------------------------------------------------------

describe("the AI-assisted path", () => {
  beforeEach(() => {
    process.env.USE_AI = "true";
  });

  test("returns AI-assisted data", async () => {
    structuredCompletion.mockResolvedValue(aiReply());

    const result = await extract(FULL_EMAIL);

    // Non-identity fields take the AI's answer outright. `company` is asserted
    // separately, under "identity fields", because it does not.
    expect(result.data.time).toBe("14:30");
    expect(result.data.venue).toBe("zoom");
    expect(result.data.stage).toBe("Interview");
  });

  // The service disables the AI Core's default retrying with `NO_RETRY`, so one
  // email is one billable call. Asserted at this boundary — the observable
  // contract — rather than by reaching into the RetryPolicy, which has its own
  // behaviour and is not what this protects. A drain of N emails must cost N
  // calls, not 3N.
  test("calls the provider exactly once per email", async () => {
    structuredCompletion.mockResolvedValue(aiReply());

    await extract(FULL_EMAIL);

    expect(structuredCompletion).toHaveBeenCalledTimes(1);
  });

  // Even a total provider failure must cost exactly one attempt, since a
  // silently-retrying failure path is the expensive way to end up regex-only.
  test("calls the provider exactly once even when it fails", async () => {
    structuredCompletion.mockRejectedValue(new Error("boom"));

    await extract(FULL_EMAIL);

    expect(structuredCompletion).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 5 & 6. The merge.
// ---------------------------------------------------------------------------

describe("merging the AI result over the deterministic one", () => {
  beforeEach(() => {
    process.env.USE_AI = "true";
  });

  // Every field here has a DIFFERENT regex value, so each assertion fails if
  // precedence inverts rather than passing by coincidence.
  //
  // `company` is absent on purpose — it is an identity field and the
  // deterministic value wins for it. That rule has its own describe block.
  test("a usable AI value wins over the regex value", async () => {
    structuredCompletion.mockResolvedValue(aiReply());

    const result = await extract(FULL_EMAIL);

    expect(result.data).toMatchObject({
      stage: "Interview", // regex: OA
      time: "14:30", // regex: 10:00
      venue: "zoom", // regex: hackerrank
    });
  });

  // THE PROPERTY THAT MATTERS MOST about the merge: it is per field, so a model
  // that resolves some of an email does not discard what the patterns resolved
  // about the rest. An all-or-nothing merge would pass the test above and fail
  // this one.
  test("falls back per field, not all-or-nothing", async () => {
    structuredCompletion.mockResolvedValue({
      company: null,
      stage: "Interview",
      date: null,
      time: "16:45",
      venue: null,
    });

    const result = await extract(NO_TIME_EMAIL);

    // Taken from the AI.
    expect(result.data.stage).toBe("Interview");
    expect(result.data.time).toBe("16:45");
    // Taken from the patterns, because the AI supplied nothing usable.
    expect(result.data.company).toBe("amazon");
    expect(result.data.date).toBe("2027-08-16");
    expect(result.data.venue).toBe("hackerrank");
  });

  test("an empty AI reply leaves the deterministic result intact", async () => {
    structuredCompletion.mockResolvedValue({});

    const result = await extract(FULL_EMAIL);

    expect(result.data).toMatchObject(FULL_EMAIL_REGEX_RESULT);
  });
});

// ---------------------------------------------------------------------------
// Identity fields.
//
// `company` and `stage` are not ordinary extracted values: together with the
// date they ARE the `eventKey`, and every recognition tier compares them by SQL
// equality — `findByEventKey` on the whole key, `findNearbyEvents` and
// `findByCompanyAndStage` on the columns. A label the model worded differently
// is therefore not a cosmetic difference: it is a different identity, and the
// observation becomes a duplicate Event instead of an update to the real one.
//
// These tests pin the extraction layer supplying COMPATIBLE identity fields.
// The recognition engine, the identity gate and `eventKey` are untouched.
// ---------------------------------------------------------------------------

describe("stage is constrained to the vocabulary the system already speaks", () => {
  beforeEach(() => {
    process.env.USE_AI = "true";
  });

  // THE FAILURE THE AUDIT FOUND. "Online Assessment" is a correct description
  // of the round and a fatal identity label: the key becomes
  // `infosys|Online Assessment|2027-08-16`, tier 1 misses the existing
  // `infosys|OA|…`, and tier 2 then sees "oa" vs "online assessment", returns
  // CONTRADICTS, and vetoes the correct candidate before scoring it.
  test("an off-vocabulary AI stage never reaches the result", async () => {
    structuredCompletion.mockResolvedValue(aiReply({ stage: "Online Assessment" }));

    const result = await extract(FULL_EMAIL);

    expect(result.data.stage).not.toBe("Online Assessment");
    expect(result.data.stage).toBe("OA"); // the deterministic round survives
  });

  test.each([
    ["a synonym", "Online Assessment"],
    ["an invented round", "Technical Round 2"],
    ["an empty string", ""],
    ["whitespace", "   "],
    ["a non-string", 42],
    ["null", null],
  ])("rejects %s and keeps the deterministic round", async (_label, stage) => {
    structuredCompletion.mockResolvedValue(aiReply({ stage }));

    const result = await extract(FULL_EMAIL);

    expect(result.data.stage).toBe("OA");
  });

  test("a canonical AI stage is still used", async () => {
    structuredCompletion.mockResolvedValue(aiReply({ stage: "Interview" }));

    const result = await extract(FULL_EMAIL);

    expect(result.data.stage).toBe("Interview");
  });

  // Case folding is not a synonym mapping: the engine already compares rounds
  // case-insensitively (`classifyRoundIdentity`, `scoreEventMatch`). Emitting
  // the canonical spelling is what keeps `eventKey`, where comparison is exact,
  // agreeing with the engine that already considers these the same round.
  test("a canonical stage in the wrong case is accepted in canonical spelling", async () => {
    structuredCompletion.mockResolvedValue(aiReply({ stage: "iNtErViEw" }));

    const result = await extract(FULL_EMAIL);

    expect(result.data.stage).toBe("Interview");
  });

  // The AI still adds real value here: the patterns resolved no round at all,
  // so accepting a canonical one costs no identity and gains information.
  test("supplies the round when the patterns could not", async () => {
    structuredCompletion.mockResolvedValue(aiReply({ stage: "Interview" }));

    const result = await extract(NO_STAGE_EMAIL);

    expect(result.data.stage).toBe("Interview");
  });

  test("leaves the unresolved placeholder when the AI round is off-vocabulary too", async () => {
    structuredCompletion.mockResolvedValue(aiReply({ stage: "Coding Round" }));

    const result = await extract(NO_STAGE_EMAIL);

    // The existing unresolved behaviour, unchanged — `matching.utils` reads this
    // literal as "no claim about the round" rather than as a round.
    expect(result.data.stage).toBe("unknown");
  });

  // ANTI-DRIFT GUARD. The allowlist restates a vocabulary that `extractStage`
  // owns, so the two could silently diverge — a round the patterns still emit
  // but the merge no longer accepts would be discarded on every AI-enabled
  // email. This checks both halves against each other.
  describe("the allowlist covers everything the patterns can produce", () => {
    const rounds: [string, string][] = [
      ["online test", "OA"],
      ["interview", "Interview"],
      ["ppt", "PPT"],
      ["register", "Registration"],
    ];

    test.each(rounds)(
      "%s is extracted as %s and survives the merge",
      async (text, canonical) => {
        // The patterns really do produce this label...
        expect(extractStage(text)).toBe(canonical);

        // ...and the merge accepts it from the AI rather than discarding it.
        structuredCompletion.mockResolvedValue(aiReply({ stage: canonical }));

        const result = await extract(NO_STAGE_EMAIL);

        expect(result.data.stage).toBe(canonical);
      },
    );
  });
});

describe("company identity belongs to the deterministic extractor", () => {
  beforeEach(() => {
    process.env.USE_AI = "true";
  });

  // THE OTHER FAILURE THE AUDIT FOUND, and the more dangerous one: no gate even
  // sees it. `findNearbyEvents` and `findByCompanyAndStage` filter
  // `company: company` as SQL equality, so a reworded company returns ZERO
  // candidates — tiers 2 and 3 do not veto the right Event, they never load it.
  // A duplicate is then created with nothing having refused anything.
  test("a reworded AI company does not replace the deterministic one", async () => {
    structuredCompletion.mockResolvedValue(aiReply({ company: "Infosys Limited" }));

    const result = await extract(FULL_EMAIL);

    expect(result.data.company).not.toBe("Infosys Limited");
    expect(result.data.company).toBe("infosys");
  });

  // Not a casing rule. The deterministic value wins because it is the STABLE
  // producer of an identity token — re-extracting the same email always yields
  // it, and every Event already stored was keyed from it.
  test.each([
    ["different casing", "INFOSYS"],
    ["a legal suffix", "Infosys Technologies Ltd."],
    ["a shorter form", "Infy"],
  ])("ignores %s in favour of the deterministic company", async (_label, company) => {
    structuredCompletion.mockResolvedValue(aiReply({ company }));

    const result = await extract(FULL_EMAIL);

    expect(result.data.company).toBe("infosys");
  });

  // Where there is no identity to preserve, the AI is the whole value: without
  // a company the viability gate in `email.service` ABANDONS the email, so this
  // is the case that turns a discarded observation into an Event.
  test("supplies the company when the patterns could not", async () => {
    structuredCompletion.mockResolvedValue(aiReply({ company: "amazon" }));

    const result = await extract(NO_COMPANY_EMAIL);

    expect(result.data.company).toBe("amazon");
  });

  test("keeps the unresolved placeholder when neither could", async () => {
    structuredCompletion.mockResolvedValue(aiReply({ company: null }));

    const result = await extract(NO_COMPANY_EMAIL);

    // Still the placeholder, so the viability gate still abandons it — the
    // existing behaviour for an observation with no identity anchor.
    expect(result.data.company).toBe("unknown");
  });

  // WHY THE PRECEDENCE RULE NEEDED A STRONGER PREDICATE.
  //
  // "deterministic wins" is only safe while "deterministic resolved a company"
  // is a real test. It was not: the predicate rejected the literal placeholder
  // and nothing else, so the pattern layer's "https" outranked whatever the
  // model had read, and Event 76 was created as `https|OA|2026-08-27` at
  // confidence 1.0. The rule is unchanged; what changed is that a fragment no
  // longer counts as a deterministic answer.
  test("a scheme fragment from the patterns does not beat a valid AI company", async () => {
    structuredCompletion.mockResolvedValue(aiReply({ company: "Acme" }));

    const result = await extract(URL_COMPANY_EMAIL);

    expect(result.data.company).not.toBe("https");
    expect(result.data.company).toBe("acme");
  });

  test("neither side usable still yields the placeholder", async () => {
    structuredCompletion.mockResolvedValue(aiReply({ company: "https" }));

    const result = await extract(URL_COMPANY_EMAIL);

    expect(result.data.company).toBe("unknown");
  });

  // The model's JSON is typed but never runtime-validated. A non-string must not
  // reach `.trim()` — `extract()` catches provider failures, not failures in the
  // merge, so that would fail the job and burn a retry rather than degrade.
  test("a non-string AI company degrades to the placeholder instead of throwing", async () => {
    structuredCompletion.mockResolvedValue(aiReply({ company: 42 }));

    await expect(extract(NO_COMPANY_EMAIL)).resolves.toMatchObject({
      data: { company: "unknown" },
    });
  });
});

// ---------------------------------------------------------------------------
// Canonical company identity.
//
// The first AI-enabled run created two duplicate Event pairs, and neither was a
// reconciliation failure: `zanskar` / `Zanskar` and `Hindustan Unilever Ltd` /
// `Hindustan Unilever Ltd.` produce different `eventKey`s, and tiers 2 and 3
// compare `company` as SQL equality, so the correct candidate was never even
// loaded — nothing vetoed anything.
//
// One spelling per company is what closes that. The canonical form is the one
// the patterns already emit (`email.service` lower-cases the body first), so
// this adopts the existing convention rather than inventing one.
// ---------------------------------------------------------------------------

describe("company identity is canonical", () => {
  beforeEach(() => {
    process.env.USE_AI = "true";
  });

  // The exact production pair: the patterns supplied one spelling, the model the
  // other. Both must land on the same identity whichever side wins.
  test("casing cannot fork the identity", async () => {
    structuredCompletion.mockResolvedValue(aiReply({ company: "Zanskar" }));
    const fromAi = await extract(NO_COMPANY_EMAIL);

    structuredCompletion.mockResolvedValue(aiReply({ company: "zanskar" }));
    const fromPatterns = await extract(NO_COMPANY_EMAIL);

    expect(fromAi.data.company).toBe("zanskar");
    expect(fromAi.data.company).toBe(fromPatterns.data.company);
  });

  // The other production pair, and the one that proves the model contradicts
  // ITSELF: both spellings came from the AI, on two different emails.
  test("a trailing period cannot fork the identity", async () => {
    structuredCompletion.mockResolvedValue(
      aiReply({ company: "Hindustan Unilever Ltd." }),
    );
    const withPeriod = await extract(NO_COMPANY_EMAIL);

    structuredCompletion.mockResolvedValue(
      aiReply({ company: "Hindustan Unilever Ltd" }),
    );
    const withoutPeriod = await extract(NO_COMPANY_EMAIL);

    expect(withPeriod.data.company).toBe("hindustan unilever ltd");
    expect(withPeriod.data.company).toBe(withoutPeriod.data.company);
  });

  test.each([
    ["surrounding whitespace", "  Zanskar  ", "zanskar"],
    ["collapsed inner whitespace", "hindustan   unilever", "hindustan unilever"],
    ["a newline between words", "Morphle\nLabs", "morphle labs"],
    ["all three at once", "  Hindustan   Unilever Ltd. ", "hindustan unilever ltd"],
  ])("normalises %s", async (_label, supplied, expected) => {
    structuredCompletion.mockResolvedValue(aiReply({ company: supplied }));

    const result = await extract(NO_COMPANY_EMAIL);

    expect(result.data.company).toBe(expected);
  });

  // Interior punctuation CARRIES the name and is deliberately preserved. Only a
  // trailing period is dropped, so this is identity stability rather than tidying.
  test("interior punctuation is preserved", async () => {
    structuredCompletion.mockResolvedValue(
      aiReply({ company: "Infrasphere Projects Pvt. Ltd." }),
    );

    const result = await extract(NO_COMPANY_EMAIL);

    expect(result.data.company).toBe("infrasphere projects pvt. ltd");
  });

  test("a company the patterns resolved is already canonical and unchanged", async () => {
    structuredCompletion.mockResolvedValue(aiReply({ company: "Infosys Limited" }));

    const result = await extract(FULL_EMAIL);

    expect(result.data.company).toBe("infosys");
  });
});

// ---------------------------------------------------------------------------
// 7 & 8. The date evidence guard, applied.
// ---------------------------------------------------------------------------

describe("the AI date is checked against the email's own evidence", () => {
  beforeEach(() => {
    process.env.USE_AI = "true";
  });

  // date-evidence.test.ts already pins `validateAIDate` itself. What is pinned
  // HERE is that `extract()` actually routes the AI's date through it — the
  // guard existing and the guard being applied are different facts, and only
  // the second one protects production.
  test("an unsupported AI date is discarded and the regex date survives", async () => {
    // The email says the 16th; the model answers the 17th.
    structuredCompletion.mockResolvedValue(aiReply({ date: "2027-08-17" }));

    const result = await extract(NO_TIME_EMAIL);

    expect(result.data.date).toBe("2027-08-16");
  });

  // The other half: the guard rejects fabrications, not AI dates as a class.
  // The model selects the SECOND date in the email, which the deterministic
  // extractor never reaches (it takes the first), so an accepted AI date is
  // distinguishable from a regex fallback here.
  test("a supported AI date is accepted, even when it is not the first one", async () => {
    structuredCompletion.mockResolvedValue(aiReply({ date: "2027-08-10" }));

    const result = await extract(TWO_DATE_EMAIL);

    expect(result.data.date).toBe("2027-08-10");
  });
});

// ---------------------------------------------------------------------------
// 3, 4 & 10. Fail-soft.
// ---------------------------------------------------------------------------

// The contract the production drain depends on: an AI failure degrades ONE
// email to regex-only. It never rejects, so it never fails the BullMQ job, so
// it never burns a retry or lands the email in `failed`. Each error below is a
// real failure mode of the path — the typed ones are what `structuredCompletion`
// actually throws, and the bare `Error` is what `getOpenAIClient` throws when
// the key is missing, which is the shape a misconfigured deployment produces.
describe("an AI failure degrades to regex-only", () => {
  beforeEach(() => {
    process.env.USE_AI = "true";
  });

  const failures: [string, unknown][] = [
    ["a provider fault", new ProviderError("OpenAI request failed (429)", true)],
    [
      "a malformed response",
      new MalformedResponseError("Invalid JSON from AI provider", "not json"),
    ],
    ["an empty response", new EmptyResponseError()],
    // Not hypothetical: `getOpenAIClient` throws exactly this when the secret is
    // absent, so this is what a drain running without OPENAI_API_KEY would do —
    // silently, on every email. It is why the workflow verifies the key up front.
    ["a missing API key", new Error("OPENAI_API_KEY not set")],
    ["an unexpected fault", new Error("boom")],
    // A rejection carrying no `.message` at all must not become a second,
    // different failure inside the catch itself.
    ["a non-Error rejection", "just a string"],
  ];

  test.each(failures)("does not throw on %s", async (_label, error) => {
    structuredCompletion.mockRejectedValue(error);

    await expect(extract(FULL_EMAIL)).resolves.toBeDefined();
  });

  test.each(failures)(
    "returns the deterministic result on %s",
    async (_label, error) => {
      structuredCompletion.mockRejectedValue(error);

      const result = await extract(FULL_EMAIL);

      expect(result.data).toMatchObject(FULL_EMAIL_REGEX_RESULT);
    },
  );

  // A degraded email is still a usable observation, not a broken one: the
  // downstream decision reads `status` and `confidence`, so both must survive
  // the fallback rather than arriving undefined.
  test("the result stays well-formed after a failure", async () => {
    structuredCompletion.mockRejectedValue(new Error("boom"));

    const result = await extract(FULL_EMAIL);

    expect(result.status).toBe("complete");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.isTimeEstimated).toBe(false);
  });
});
