// Planning and verification for the one-off Event-identity cleanup.
//
// Split out from the entrypoint on exactly the reasoning behind
// scripts/recovery/selection.ts: this module imports no Prisma client, no
// database driver and no queue, so the logic that decides WHICH production rows
// are deleted and rewritten can be exercised from fixtures with no connection
// in existence. That decision is the part whose failure is silent and
// irreversible — a wrong id deletes the wrong Event and there is no undo.
//
// The two things it does import are the production definitions of company
// canonicalisation and identity-key generation. They are imported rather than
// copied because this script REWRITES the identity of rows that the extractor
// must later match: a second, drifting definition of "canonical" here would
// reintroduce precisely the class of bug the cleanup exists to remove.

import { canonicalCompany } from "../../src/modules/extraction/extraction.utils.js";
import { generateEventKey } from "../../src/modules/event/event.utils.js";

// ---------------------------------------------------------------------------
// Row shapes. Structural rather than imported from the generated Prisma client,
// which is what keeps this module runnable without a database.
// ---------------------------------------------------------------------------

export type EventRow = {
  id: number;
  userId: number;
  company: string;
  stage: string;
  date: Date;
  time: string | null;
  venue: string | null;
  eventKey: string;
  confidence: number;
  status: string;
  reviewReason: string | null;
  isTimeEstimated: boolean;
};

export type EventUpdateRow = {
  id: number;
  eventId: number;
  userId: number;
  field: string;
  oldValue: string;
  newValue: string;
  updatedAt: Date;
};

export type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
};

// ---------------------------------------------------------------------------
// The approved plan, as data.
//
// Every id here was decided by a human after the read-only inventory. Nothing
// below discovers a target: the script's job is to REFUSE to run if production
// no longer looks like the state those decisions were made against, not to
// re-derive the decisions from whatever it finds.
// ---------------------------------------------------------------------------

/** Group A — the Hindustan Unilever duplicate. */
export const HUL_SURVIVOR = 68;
export const HUL_DUPLICATE = 71;

/** Group B — the Zanskar duplicate. Event 72 is modified in no way. */
export const ZANSKAR_SURVIVOR = 72;
export const ZANSKAR_DUPLICATE = 77;

/** Junk identities produced by the two parser defects, plus the conflation. */
export const JUNK_EVENT_IDS = [54, 55, 76] as const;

/** Deleted, in this order. `least` (54) last, after its history is exported. */
export const DELETE_IDS = [
  HUL_DUPLICATE,
  ZANSKAR_DUPLICATE,
  76,
  55,
  54,
] as const;

/** The conflated Event whose change history must be exported before deletion. */
export const EVENT_54 = 54;
export const EVENT_54_EXPECTED_UPDATE_COUNT = 10;

/**
 * Explicitly excluded from canonicalisation by human decision.
 *
 * 37 (`TPO`) is the placement office rather than an employer, and IS
 * non-canonical — so it is the one row that will still be non-canonical after
 * the cleanup. That is intentional, and the post-condition below asserts the
 * remaining non-canonical set is EXACTLY this list rather than empty.
 *
 * 17 (`naukri.com`) and 23 (`ti`) are already canonical and would never be
 * touched anyway; they are named so a future reader can see they were
 * considered, and so the post-conditions can assert they are unchanged.
 */
export const DO_NOT_TOUCH_IDS = [37, 17, 23] as const;

/** The single field merge approved for Group A. */
export const HUL_MERGE = {
  eventId: HUL_SURVIVOR,
  field: "venue",
  oldValue: "campus",
  newValue: "tpo",
} as const;

/** Event count expected BEFORE the cleanup. A mismatch aborts. */
export const EXPECTED_INITIAL_EVENT_COUNT = 77;

/** 77 − 5 deletions. Note this is 72, not 73: Event 54 is now a deletion too. */
export const EXPECTED_FINAL_EVENT_COUNT =
  EXPECTED_INITIAL_EVENT_COUNT - DELETE_IDS.length;

/** `EmailExtraction` is never written; its row count must be identical after. */
export const EXPECTED_EXTRACTION_COUNT = 263;

// The exact rows the plan was approved against. Confidence is compared with a
// tolerance because Postgres `double precision` does not round-trip decimal
// literals exactly (Event 6 stores 0.7000000000000001).
type ExpectedEvent = {
  company: string;
  stage: string;
  date: string;
  time: string | null;
  venue: string | null;
  confidence: number;
  status: string;
  updates: number;
};

export const EXPECTED_EVENTS: Record<number, ExpectedEvent> = {
  54: { company: "least", stage: "OA", date: "2026-08-26", time: "09:45", venue: "online", confidence: 0.97, status: "rescheduled", updates: 10 },
  55: { company: "stipulated", stage: "Interview", date: "2026-08-20", time: "09:30", venue: "zoom", confidence: 1, status: "scheduled", updates: 0 },
  68: { company: "Hindustan Unilever Ltd.", stage: "Registration", date: "2026-08-26", time: "23:45", venue: "campus", confidence: 1, status: "scheduled", updates: 0 },
  71: { company: "Hindustan Unilever Ltd", stage: "Registration", date: "2026-08-26", time: "23:45", venue: "tpo", confidence: 1, status: "scheduled", updates: 0 },
  72: { company: "zanskar", stage: "Registration", date: "2026-08-27", time: "18:30", venue: "campus", confidence: 0.97, status: "scheduled", updates: 0 },
  76: { company: "https", stage: "OA", date: "2026-08-27", time: "16:45", venue: "HackerRank", confidence: 1, status: "scheduled", updates: 0 },
  77: { company: "Zanskar", stage: "Registration", date: "2026-08-27", time: "23:59", venue: "tpo", confidence: 0.93, status: "scheduled", updates: 0 },
};

const CONFIDENCE_TOLERANCE = 1e-9;

// ---------------------------------------------------------------------------
// The date component of an `eventKey`.
//
// `generateEventKey` takes the extraction's own "YYYY-MM-DD" string, which no
// longer exists by the time a row is read back — only the `DateTime`. The UTC
// calendar date reproduces it for every row currently in production, but that
// is an OBSERVATION, not a guarantee, so it is never assumed: the
// `eventKey-integrity` precondition re-derives every stored key from these
// three fields and aborts on the first row that disagrees. If the derivation is
// ever wrong, the script stops instead of writing a malformed key.
// ---------------------------------------------------------------------------
export const eventDateKey = (date: Date): string =>
  date.toISOString().slice(0, 10);

export const keyForRow = (row: {
  company: string;
  stage: string;
  date: Date;
}): string =>
  generateEventKey({
    company: row.company,
    stage: row.stage,
    date: eventDateKey(row.date),
  });

/** The identity an Event WOULD have once its company is canonicalised. */
export const canonicalKeyForRow = (row: EventRow): string =>
  generateEventKey({
    company: canonicalCompany(row.company),
    stage: row.stage,
    date: eventDateKey(row.date),
  });

export const isCanonical = (row: EventRow): boolean =>
  canonicalCompany(row.company) === row.company;

// ---------------------------------------------------------------------------
// The plan.
// ---------------------------------------------------------------------------

export type Deletion = {
  eventId: number;
  userId: number;
  company: string;
  stage: string;
  date: string;
  eventKey: string;
  dependentUpdates: number;
  reason: string;
};

export type Canonicalisation = {
  eventId: number;
  userId: number;
  fromCompany: string;
  toCompany: string;
  fromKey: string;
  toKey: string;
  stage: string;
  date: string;
};

export type Merge = {
  eventId: number;
  userId: number;
  field: string;
  oldValue: string;
  newValue: string;
};

export type CleanupPlan = {
  ok: boolean;
  preconditions: CheckResult[];
  merge: Merge | null;
  deletions: Deletion[];
  canonicalisations: Canonicalisation[];
  event54Export: EventUpdateRow[];
  summary: {
    initialEventCount: number;
    finalEventCount: number;
    deleteCount: number;
    canonicaliseCount: number;
    remainingNonCanonicalIds: number[];
  };
};

const check = (name: string, ok: boolean, detail: string): CheckResult => ({
  name,
  ok,
  detail,
});

const near = (a: number, b: number): boolean =>
  Math.abs(a - b) <= CONFIDENCE_TOLERANCE;

/** Every canonical identity owned by more than one Event, as `userId::key`. */
export const canonicalCollisionGroups = (
  events: EventRow[],
): { key: string; ids: number[] }[] => {
  const byKey = new Map<string, number[]>();

  for (const event of events) {
    const key = `${event.userId}::${canonicalKeyForRow(event)}`;
    const ids = byKey.get(key);

    if (ids) ids.push(event.id);
    else byKey.set(key, [event.id]);
  }

  return [...byKey.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => ({ key, ids: [...ids].sort((a, b) => a - b) }));
};

export const buildPlan = (input: {
  events: EventRow[];
  event54Updates: EventUpdateRow[];
  dependentUpdateCounts: Map<number, number>;
  extractionCount: number;
}): CleanupPlan => {
  const { events, event54Updates, dependentUpdateCounts, extractionCount } = input;

  const byId = new Map(events.map((event) => [event.id, event]));
  const preconditions: CheckResult[] = [];

  // ---- 1. Shape of the table as a whole ----------------------------------

  preconditions.push(
    check(
      "event-count",
      events.length === EXPECTED_INITIAL_EVENT_COUNT,
      `${events.length} Events (expected ${EXPECTED_INITIAL_EVENT_COUNT})`,
    ),
  );

  preconditions.push(
    check(
      "extraction-count",
      extractionCount === EXPECTED_EXTRACTION_COUNT,
      `${extractionCount} EmailExtraction rows (expected ${EXPECTED_EXTRACTION_COUNT}; none are written)`,
    ),
  );

  // Every stored key must be reproducible from its own fields. This is what
  // licenses `eventDateKey` — without it the rewritten keys would rest on an
  // assumption about how the date component was originally produced.
  const keyMismatches = events.filter(
    (event) => event.eventKey !== keyForRow(event),
  );

  preconditions.push(
    check(
      "eventKey-integrity",
      keyMismatches.length === 0,
      keyMismatches.length === 0
        ? `${events.length}/${events.length} stored keys reproduce from (company, stage, date)`
        : `${keyMismatches.length} row(s) whose stored key does not match their fields: ${keyMismatches
            .map((event) => event.id)
            .join(", ")}`,
    ),
  );

  // ---- 2. Each approved target, field by field ---------------------------

  for (const [rawId, expected] of Object.entries(EXPECTED_EVENTS)) {
    const id = Number(rawId);
    const event = byId.get(id);

    if (!event) {
      preconditions.push(check(`event-${id}-exists`, false, "row not found"));
      continue;
    }

    const dependents = dependentUpdateCounts.get(id) ?? 0;

    const mismatches = [
      event.company === expected.company ? null : `company=${JSON.stringify(event.company)}`,
      event.stage === expected.stage ? null : `stage=${JSON.stringify(event.stage)}`,
      eventDateKey(event.date) === expected.date ? null : `date=${eventDateKey(event.date)}`,
      event.time === expected.time ? null : `time=${JSON.stringify(event.time)}`,
      event.venue === expected.venue ? null : `venue=${JSON.stringify(event.venue)}`,
      near(event.confidence, expected.confidence) ? null : `confidence=${event.confidence}`,
      event.status === expected.status ? null : `status=${JSON.stringify(event.status)}`,
      dependents === expected.updates ? null : `EventUpdate rows=${dependents}`,
    ].filter((entry): entry is string => entry !== null);

    preconditions.push(
      check(
        `event-${id}-matches-inventory`,
        mismatches.length === 0,
        mismatches.length === 0
          ? `all fields and ${dependents} EventUpdate row(s) as inventoried`
          : `changed since the inventory: ${mismatches.join(", ")}`,
      ),
    );
  }

  // ---- 3. Ownership. No merge may ever span two users ---------------------

  const hulSurvivor = byId.get(HUL_SURVIVOR);
  const hulDuplicate = byId.get(HUL_DUPLICATE);
  const zanskarSurvivor = byId.get(ZANSKAR_SURVIVOR);
  const zanskarDuplicate = byId.get(ZANSKAR_DUPLICATE);

  preconditions.push(
    check(
      "duplicate-pairs-share-an-owner",
      hulSurvivor !== undefined &&
        hulDuplicate !== undefined &&
        zanskarSurvivor !== undefined &&
        zanskarDuplicate !== undefined &&
        hulSurvivor.userId === hulDuplicate.userId &&
        zanskarSurvivor.userId === zanskarDuplicate.userId,
      hulSurvivor && hulDuplicate && zanskarSurvivor && zanskarDuplicate
        ? `68/71 owner ${hulSurvivor.userId}/${hulDuplicate.userId}, 72/77 owner ${zanskarSurvivor.userId}/${zanskarDuplicate.userId}`
        : "one or more pair members missing",
    ),
  );

  // ---- 4. The collision groups are exactly the two that were approved -----

  const collisions = canonicalCollisionGroups(events);
  const collisionIds = collisions
    .map((group) => group.ids.join("+"))
    .sort()
    .join(" ");
  const expectedCollisionIds = ["68+71", "72+77"].sort().join(" ");

  preconditions.push(
    check(
      "canonical-collision-groups",
      collisionIds === expectedCollisionIds,
      collisions.length === 0
        ? "no canonical collisions found (expected 68+71 and 72+77)"
        : `found ${collisionIds} (expected ${expectedCollisionIds})`,
    ),
  );

  // ---- 5. Event 54's history is present and complete ----------------------

  const exportComplete =
    event54Updates.length === EVENT_54_EXPECTED_UPDATE_COUNT &&
    event54Updates.every(
      (row) =>
        row.eventId === EVENT_54 &&
        typeof row.userId === "number" &&
        typeof row.field === "string" &&
        row.field.length > 0 &&
        typeof row.oldValue === "string" &&
        typeof row.newValue === "string" &&
        row.updatedAt instanceof Date &&
        !Number.isNaN(row.updatedAt.getTime()),
    );

  preconditions.push(
    check(
      "event-54-history-exportable",
      exportComplete,
      `${event54Updates.length} EventUpdate row(s) read for Event ${EVENT_54} (expected ${EVENT_54_EXPECTED_UPDATE_COUNT}, all fields populated)`,
    ),
  );

  // ---- 6. Deletions -------------------------------------------------------

  const deletions: Deletion[] = [];
  let deletionsValid = true;

  for (const id of DELETE_IDS) {
    const event = byId.get(id);

    if (!event) {
      deletionsValid = false;
      continue;
    }

    const dependents = dependentUpdateCounts.get(id) ?? 0;

    // Every deletion except Event 54's must be free of dependents. Event 54's
    // ten rows are expected, and are exported first — that is the whole reason
    // it is treated separately rather than folded in with the others.
    if (id !== EVENT_54 && dependents !== 0) {
      deletionsValid = false;
    }

    deletions.push({
      eventId: id,
      userId: event.userId,
      company: event.company,
      stage: event.stage,
      date: eventDateKey(event.date),
      eventKey: event.eventKey,
      dependentUpdates: dependents,
      reason:
        id === HUL_DUPLICATE
          ? "duplicate of Event 68 (same canonical identity); venue merged first"
          : id === ZANSKAR_DUPLICATE
            ? "duplicate of Event 72 (same canonical identity); lower confidence, nothing copied"
            : id === EVENT_54
              ? "junk company `least`; conflates 8 observations across 4 dates; history exported"
              : id === 55
                ? "junk company `stipulated` from the `at <prose>` defect"
                : "junk company `https` from the URL-fragment defect",
    });
  }

  preconditions.push(
    check(
      "deletions-resolvable",
      deletionsValid && deletions.length === DELETE_IDS.length,
      `${deletions.length}/${DELETE_IDS.length} deletion targets present with the expected dependent counts`,
    ),
  );

  // ---- 7. Canonicalisation, and its collision safety ---------------------

  const survivorIds = new Set(events.map((event) => event.id));
  for (const id of DELETE_IDS) survivorIds.delete(id);

  const survivors = events.filter((event) => survivorIds.has(event.id));
  const excluded = new Set<number>(DO_NOT_TOUCH_IDS);

  const canonicalisations: Canonicalisation[] = survivors
    .filter((event) => !isCanonical(event) && !excluded.has(event.id))
    .map((event) => ({
      eventId: event.id,
      userId: event.userId,
      fromCompany: event.company,
      toCompany: canonicalCompany(event.company),
      fromKey: event.eventKey,
      toKey: canonicalKeyForRow(event),
      stage: event.stage,
      date: eventDateKey(event.date),
    }))
    .sort((a, b) => a.eventId - b.eventId);

  // COLLISION SAFETY, checked so that ORDER CANNOT MATTER.
  //
  // `UNIQUE(userId, eventKey)` is non-deferrable, so an update that is fine in
  // the final state can still fail midway if some other row currently holds the
  // key being claimed. Rather than sequencing the updates and hoping, this
  // demands the stronger property: no target's NEW key may equal any surviving
  // row's CURRENT key or FINAL key, other than its own. When that holds, the
  // updates are safe in any order. When it does not, the script aborts rather
  // than attempting a sequence — a one-off cleanup is the wrong place to be
  // clever about constraint timing, and temporary placeholder keys are exactly
  // what the brief forbids.
  const currentKeys = new Map<string, number>();
  const finalKeys = new Map<string, number>();
  const canonicaliseById = new Map(
    canonicalisations.map((entry) => [entry.eventId, entry]),
  );

  for (const event of survivors) {
    currentKeys.set(`${event.userId}::${event.eventKey}`, event.id);

    const planned = canonicaliseById.get(event.id);
    const finalKey = planned ? planned.toKey : event.eventKey;

    finalKeys.set(`${event.userId}::${finalKey}`, event.id);
  }

  const collidingUpdates = canonicalisations.filter((entry) => {
    const scoped = `${entry.userId}::${entry.toKey}`;
    const holderNow = currentKeys.get(scoped);
    const holderFinal = finalKeys.get(scoped);

    return (
      (holderNow !== undefined && holderNow !== entry.eventId) ||
      (holderFinal !== undefined && holderFinal !== entry.eventId)
    );
  });

  preconditions.push(
    check(
      "canonicalisation-collision-free",
      collidingUpdates.length === 0,
      collidingUpdates.length === 0
        ? `${canonicalisations.length} canonicalisation(s), none claiming a key held by another surviving Event`
        : `${collidingUpdates.length} canonicalisation(s) would collide: ${collidingUpdates
            .map((entry) => `${entry.eventId} -> ${entry.toKey}`)
            .join("; ")}`,
    ),
  );

  // The final key set must also be free of duplicates in its own right — the
  // check above is per-row, this one is the aggregate it implies.
  const finalKeyList = survivors.map((event) => {
    const planned = canonicaliseById.get(event.id);
    return `${event.userId}::${planned ? planned.toKey : event.eventKey}`;
  });

  preconditions.push(
    check(
      "final-keys-unique",
      new Set(finalKeyList).size === finalKeyList.length,
      `${new Set(finalKeyList).size} distinct identities across ${finalKeyList.length} surviving Events`,
    ),
  );

  // ---- 8. The excluded rows really are excluded ---------------------------

  const touched = new Set<number>([
    ...canonicalisations.map((entry) => entry.eventId),
    ...deletions.map((entry) => entry.eventId),
    HUL_SURVIVOR,
  ]);

  const wronglyTouched = DO_NOT_TOUCH_IDS.filter((id) => touched.has(id));

  preconditions.push(
    check(
      "do-not-touch-excluded",
      wronglyTouched.length === 0,
      wronglyTouched.length === 0
        ? `Events ${DO_NOT_TOUCH_IDS.join(", ")} appear in no operation`
        : `Events ${wronglyTouched.join(", ")} would be modified`,
    ),
  );

  // ---- 9. The Group A merge -----------------------------------------------

  const mergeValid =
    hulSurvivor !== undefined &&
    hulSurvivor.venue === HUL_MERGE.oldValue &&
    hulDuplicate !== undefined &&
    hulDuplicate.venue === HUL_MERGE.newValue;

  preconditions.push(
    check(
      "hul-merge-inputs",
      mergeValid,
      mergeValid
        ? `Event ${HUL_SURVIVOR}.venue "${HUL_MERGE.oldValue}" -> "${HUL_MERGE.newValue}" (taken from Event ${HUL_DUPLICATE} at equal confidence, matching updateEventService)`
        : "Event 68 or 71 no longer holds the venue the merge was approved against",
    ),
  );

  const merge: Merge | null =
    mergeValid && hulSurvivor
      ? {
          eventId: HUL_SURVIVOR,
          userId: hulSurvivor.userId,
          field: HUL_MERGE.field,
          oldValue: HUL_MERGE.oldValue,
          newValue: HUL_MERGE.newValue,
        }
      : null;

  const remainingNonCanonicalIds = survivors
    .filter((event) => !isCanonical(event) && excluded.has(event.id))
    .map((event) => event.id)
    .sort((a, b) => a - b);

  return {
    ok: preconditions.every((entry) => entry.ok),
    preconditions,
    merge,
    deletions,
    canonicalisations,
    event54Export: event54Updates,
    summary: {
      initialEventCount: events.length,
      finalEventCount: events.length - deletions.length,
      deleteCount: deletions.length,
      canonicaliseCount: canonicalisations.length,
      remainingNonCanonicalIds,
    },
  };
};

// ---------------------------------------------------------------------------
// Post-conditions. Run against a FRESH read taken inside the same transaction
// as the mutations, so a failure rolls the whole thing back.
// ---------------------------------------------------------------------------

export const verifyPostConditions = (input: {
  events: EventRow[];
  event54UpdateCount: number;
  hulMergeUpdateCount: number;
  extractionCount: number;
}): CheckResult[] => {
  const { events, event54UpdateCount, hulMergeUpdateCount, extractionCount } = input;

  const byId = new Map(events.map((event) => [event.id, event]));
  const checks: CheckResult[] = [];

  checks.push(
    check(
      "final-event-count",
      events.length === EXPECTED_FINAL_EVENT_COUNT,
      `${events.length} Events (expected ${EXPECTED_FINAL_EVENT_COUNT} = ${EXPECTED_INITIAL_EVENT_COUNT} − ${DELETE_IDS.length})`,
    ),
  );

  const absent = DELETE_IDS.filter((id) => byId.has(id));

  checks.push(
    check(
      "deleted-events-absent",
      absent.length === 0,
      absent.length === 0
        ? `Events ${DELETE_IDS.join(", ")} are gone`
        : `still present: ${absent.join(", ")}`,
    ),
  );

  checks.push(
    check(
      "survivors-present",
      byId.has(HUL_SURVIVOR) && byId.has(ZANSKAR_SURVIVOR),
      `Event ${HUL_SURVIVOR} present=${byId.has(HUL_SURVIVOR)}, Event ${ZANSKAR_SURVIVOR} present=${byId.has(ZANSKAR_SURVIVOR)}`,
    ),
  );

  // NOT "zero non-canonical". Event 37 is deliberately left alone and IS
  // non-canonical, so the honest invariant is that the remaining set is exactly
  // the excluded list — an empty result here would mean Event 37 was rewritten.
  const stillNonCanonical = events
    .filter((event) => !isCanonical(event))
    .map((event) => event.id)
    .sort((a, b) => a - b);

  const expectedRemaining = [...DO_NOT_TOUCH_IDS]
    .filter((id) => {
      const event = byId.get(id);
      return event !== undefined && !isCanonical(event);
    })
    .sort((a, b) => a - b);

  checks.push(
    check(
      "non-canonical-set-is-exactly-the-excluded-rows",
      stillNonCanonical.join(",") === expectedRemaining.join(","),
      `non-canonical after cleanup: [${stillNonCanonical.join(", ")}] (expected exactly the excluded rows [${expectedRemaining.join(", ")}] — Event 37 is left alone by decision)`,
    ),
  );

  const keyMismatches = events.filter(
    (event) => event.eventKey !== keyForRow(event),
  );

  checks.push(
    check(
      "eventKey-integrity",
      keyMismatches.length === 0,
      `${events.length - keyMismatches.length}/${events.length} keys reproduce from their own fields`,
    ),
  );

  const collisions = canonicalCollisionGroups(events);

  checks.push(
    check(
      "no-canonical-collisions",
      collisions.length === 0,
      collisions.length === 0
        ? "0 canonical identity collisions"
        : `still colliding: ${collisions.map((group) => group.ids.join("+")).join(", ")}`,
    ),
  );

  const survivor = byId.get(HUL_SURVIVOR);
  const expectedHulKey = survivor
    ? generateEventKey({
        company: "hindustan unilever ltd",
        stage: "Registration",
        date: "2026-08-26",
      })
    : "";

  checks.push(
    check(
      "event-68-final-state",
      survivor !== undefined &&
        survivor.company === "hindustan unilever ltd" &&
        survivor.stage === "Registration" &&
        eventDateKey(survivor.date) === "2026-08-26" &&
        survivor.venue === "tpo" &&
        survivor.eventKey === expectedHulKey,
      survivor
        ? `company=${JSON.stringify(survivor.company)} stage=${survivor.stage} date=${eventDateKey(survivor.date)} venue=${JSON.stringify(survivor.venue)} eventKey=${JSON.stringify(survivor.eventKey)}`
        : "Event 68 missing",
    ),
  );

  const zanskar = byId.get(ZANSKAR_SURVIVOR);
  const zanskarExpected = EXPECTED_EVENTS[ZANSKAR_SURVIVOR]!;

  checks.push(
    check(
      "event-72-untouched",
      zanskar !== undefined &&
        zanskar.company === zanskarExpected.company &&
        zanskar.time === zanskarExpected.time &&
        zanskar.venue === zanskarExpected.venue &&
        near(zanskar.confidence, zanskarExpected.confidence),
      zanskar
        ? `company=${JSON.stringify(zanskar.company)} time=${JSON.stringify(zanskar.time)} venue=${JSON.stringify(zanskar.venue)} confidence=${zanskar.confidence}`
        : "Event 72 missing",
    ),
  );

  for (const id of DO_NOT_TOUCH_IDS) {
    const event = byId.get(id);
    const expectedCompany = { 37: "TPO", 17: "naukri.com", 23: "ti" }[id];

    checks.push(
      check(
        `event-${id}-untouched`,
        event !== undefined &&
          event.company === expectedCompany &&
          event.eventKey === keyForRow(event),
        event
          ? `company=${JSON.stringify(event.company)} eventKey=${JSON.stringify(event.eventKey)}`
          : `Event ${id} missing`,
      ),
    );
  }

  checks.push(
    check(
      "event-54-history-cascaded",
      event54UpdateCount === 0,
      `${event54UpdateCount} EventUpdate row(s) remain for Event ${EVENT_54} (expected 0; the export holds them)`,
    ),
  );

  checks.push(
    check(
      "hul-merge-recorded",
      hulMergeUpdateCount === 1,
      `${hulMergeUpdateCount} venue EventUpdate row(s) on Event ${HUL_SURVIVOR} (expected 1)`,
    ),
  );

  checks.push(
    check(
      "extractions-untouched",
      extractionCount === EXPECTED_EXTRACTION_COUNT,
      `${extractionCount} EmailExtraction rows (expected ${EXPECTED_EXTRACTION_COUNT} — this cleanup writes none)`,
    ),
  );

  return checks;
};
