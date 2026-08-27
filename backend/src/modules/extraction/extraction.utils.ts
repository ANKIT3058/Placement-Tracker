import {
  cleanEmail,
  findDateEvidence,
  isResolvedCompany,
  UNRESOLVED_COMPANY,
  type VenueMeta,
} from "../email/email.parser.js";

// A full calendar date is only trustworthy when the source text actually says
// which day and month it is. The AI can turn a standalone year ("in 2027") or
// a month+year ("August 2027") into a plausible-looking "YYYY-MM-DD" by
// inventing the missing day (and/or month), and syntactic validity alone
// can't catch that — "2027-01-01" is a well-formed date whether or not
// January 1st was ever mentioned. This checks the AI's specific candidate
// against every day+month mention in the source (not just the first one),
// so a later date in a multi-date email is still recognised as supported.
//
// `sourceText` is run through `cleanEmail` before scanning, the same way
// `extractData` does, so a date that appears only in a quoted/forwarded
// thread (a real date, just belonging to a different email) can't authorize
// the AI's candidate for the current message.
export const validateAIDate = (
  candidateDate: string | null | undefined,
  sourceText: string,
): string | null => {
  if (!candidateDate) return null;

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(candidateDate);
  if (!isoMatch) return null;

  const year = parseInt(isoMatch[1]!, 10);
  const month = parseInt(isoMatch[2]!, 10) - 1;
  const day = parseInt(isoMatch[3]!, 10);
  const currentYear = new Date().getUTCFullYear();

  const isSupported = findDateEvidence(cleanEmail(sourceText)).some(
    (evidence) =>
      evidence.day === day &&
      evidence.month === month &&
      // An evidence mention with no year matches a candidate year only when
      // that candidate is the same current-year default the deterministic
      // extractor itself would have applied (see `extractExactDate`).
      (evidence.year === year ||
        (evidence.year === null && year === currentYear)),
  );

  return isSupported ? candidateDate : null;
};

// The rounds the deterministic extractor can produce, and therefore the only
// round labels allowed to reach an `eventKey`.
//
// NOT A NEW VOCABULARY. These are exactly the values `extractStage` returns in
// email.parser.ts, which the extraction prompt already restates back to the
// model. Naming them here gives the merge something to check the model's answer
// against; it introduces no spelling the system was not already using.
const CANONICAL_STAGES = ["OA", "Interview", "PPT", "Registration"] as const;

// The model's round, if it is one this system already speaks — otherwise null.
//
// Matched case-insensitively and returned in the CANONICAL spelling, because
// the repository already treats round comparison as case-insensitive:
// `classifyRoundIdentity` and `scoreEventMatch` both lower-case each side
// before comparing. So "interview" and "Interview" are already the same round
// to the engine; what this adds is that only one of those spellings may become
// part of an identity key, where comparison is exact.
//
// DELIBERATELY NOT A SYNONYM TABLE. "Online Assessment" is rejected rather than
// mapped to "OA": no established mapping exists in this repository to reuse,
// and inventing one would put an unreviewed guess into `eventKey`. A rejected
// round falls back to the deterministic one, which is the same thing that
// already happens for every other absent AI field.
const canonicalStage = (stage: unknown): string | null => {
  if (typeof stage !== "string") return null;

  const normalized = stage.trim().toLowerCase();

  return (
    CANONICAL_STAGES.find(
      (canonical) => canonical.toLowerCase() === normalized,
    ) ?? null
  );
};

// One spelling per company, so one identity per company.
//
// `eventKey` is `${company}|${stage}|${date}` compared as an exact string, and
// the two candidate queries behind tiers 2 and 3 compare `company` as SQL
// equality. A company that arrives worded differently is therefore not a
// cosmetic difference — it is a different Event. The first AI-enabled run
// created two duplicate pairs this way: `Zanskar` beside `zanskar` (the model
// supplied one, the patterns the other) and `Hindustan Unilever Ltd.` beside
// `Hindustan Unilever Ltd` (the model was inconsistent with ITSELF across two
// emails).
//
// The canonical form is the one the deterministic extractor already produces:
// `email.service` lower-cases the body before extraction, so a pattern-derived
// company is always lower case. This adopts that existing convention rather than
// inventing one — it is what makes an AI-supplied company comparable to a
// pattern-supplied one.
//
// The trailing period is the only punctuation removed, and only at the end:
// "Ltd." and "Ltd" are the same company, while the interior dots in
// "infrasphere projects pvt. ltd." carry the name and stay. This is identity
// stability, not tidying — nothing else about the string is touched, and no
// fuzzy comparison is introduced anywhere.
//
// A non-string reaches this only from the model's JSON, which is typed but never
// runtime-validated. It becomes the placeholder rather than throwing: `extract()`
// catches provider failures, not failures in the merge below it, so a `.trim()`
// on a number would fail the whole job and burn a BullMQ retry. The placeholder
// is also the honest answer — a number is not a company, and the viability gate
// already knows what to do with one.
const canonicalCompany = (company: unknown): string =>
  typeof company === "string"
    ? company.trim().replace(/\s+/g, " ").replace(/\.$/, "").toLowerCase()
    : UNRESOLVED_COMPANY;

export const mergeExtraction = (ai: any, regex: any) => {
  // AI returns a plain string; if AI extracted a venue, treat it as explicit.
  // Otherwise fall back to the VenueMeta from the regex layer.
  const venueMeta: VenueMeta =
    ai.venue != null
      ? { value: ai.venue as string, isExplicit: true }
      : (regex.venue as VenueMeta);

  return {
    // IDENTITY FIELD. `company` and `stage` are the two extracted values that
    // become an `eventKey` (`${company}|${stage}|${date}`), and all three
    // recognition tiers compare them EXACTLY — `findByEventKey` on the whole
    // key, `findNearbyEvents` and `findByCompanyAndStage` on `company` (and
    // `stage`) as SQL equality. An identity token therefore has to be stable
    // across re-extractions of the same email, and the deterministic extractor
    // is the only producer that is: with `USE_AI=true` extraction is
    // nondeterministic (see extraction.repository), and every Event already in
    // the database was keyed from a deterministic company.
    //
    // So the deterministic company wins whenever it resolved one, and the AI's
    // wording is used only where there is no identity to preserve. That is not
    // a demotion of the AI: an unresolved company is ABANDONED by the viability
    // gate in email.service, so this is precisely the case where an AI company
    // turns a discarded email into an Event.
    //
    // `isResolvedCompany` rather than a truthiness check, because the extractor
    // substitutes the literal "unknown" when it finds nothing and that string is
    // truthy — the same distinction the viability gate makes.
    //
    // THE PREDICATE IS WHAT MAKES THIS RULE SAFE, and it was too weak. It used to
    // accept anything that was not the literal placeholder, so the pattern layer's
    // "https" counted as a resolved company and outranked whatever the model had
    // read — Event 76, `https|OA|2026-08-27`, at confidence 1.0. It now delegates
    // to the same `isValidCompany` the extractor applies to its own output, so a
    // scheme fragment is not a company here either and the AI's value is used.
    //
    // The rule itself is unchanged: a usable deterministic company still wins,
    // because it is the only stable producer of an identity token. What changed is
    // that "usable" now means usable — and that the SAME test is applied to the
    // model's answer, so a fragment cannot enter from that side either. Neither
    // side usable falls through to the extractor's placeholder, which is what the
    // viability gate is waiting for.
    company: canonicalCompany(
      isResolvedCompany(regex.company)
        ? regex.company
        : isResolvedCompany(ai.company)
          ? ai.company
          : regex.company,
    ),

    // IDENTITY FIELD. Only a round this system already speaks may pass; anything
    // else falls back to the deterministic round exactly as a missing AI field
    // would. Without this an off-vocabulary label ("Online Assessment" for what
    // the patterns call "OA") produces a key no existing Event can match, the
    // identity gate then CONTRADICTS the correct candidate at tier 2, and the
    // observation becomes a duplicate Event instead of an update.
    stage: canonicalStage(ai.stage) ?? regex.stage,

    date: ai.date || regex.date,
    time: ai.time ?? regex.time,
    venue: venueMeta.value,   // plain string | null — used by DB writes & confidence scoring
    venueMeta,                // carries isExplicit — used by update logic
  };
};

export const calculateConfidence = (data: any) => {
  let score = 0;

  if (data.company) score += 0.25;
  if (data.stage) score += 0.2;
  if (data.date) score += 0.3;
  if (data.time) score += 0.15;
  if (data.venue) score += 0.1;

  return score;
};

export const getExtractionStatus = (data: any) => {
  if (!data.company || !data.stage || !data.date) return "failed";
  if (!data.time || !data.venue) return "partial";
  return "complete";
};

export const detectEstimatedTime = (text: string) => {
  return /around|approx|morning|afternoon|evening/i.test(text);
};