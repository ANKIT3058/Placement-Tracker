import { prisma } from "../../lib/prisma.js";
import { createEvent } from "./event.repository.js";

import { generateEventKey, classifyTemporalStatus } from "./event.utils.js";
import { toUTCDate, toISTKey } from "../../shared/utils/date.js";
import type { CreateEventInput, ManualEventUpdate } from "./event.types.js";
import type { OwnershipContext } from "../auth/tenant-context.js";

// CREATE
export const createEventService = async (
  owner: OwnershipContext,
  data: CreateEventInput,
) => {
  const eventKey = generateEventKey({
    company: data.company,
    stage: data.stage,
    date: data.date,
  });

  return createEvent(owner, data, eventKey);
};

// UPDATE
export const updateEventService = async (
  owner: OwnershipContext,
  eventId: number,
  existing: any,
  incoming: CreateEventInput,
) => {
  // MANUAL AUTHORITY (AC-3 / D-9).
  //
  // A human decision is the highest authority in the system, and `confirmed` is
  // the state that records one. Automated inference may not revise a confirmed
  // Event at all — not even when its confidence is equal or higher.
  //
  // The guard is on status rather than on the confidence comparison below,
  // because authority is categorical and confidence is a quantity. Manual
  // confirmation sets confidence to exactly 1.0, and a maximally-confident
  // extraction also reaches 1.0, so the incumbent comparator cannot tell "a
  // person settled this" apart from "the extractor was very sure". Tightening
  // that comparator to `<=` would express the same intent as a numeric
  // coincidence and would additionally reject equal-confidence automated
  // updates between two inferences, which is unrelated behaviour. It is left
  // untouched.
  //
  // This is the only automated write path to an Event, so this is the only
  // place the guard is needed. `updateEventManuallyService` is the human path
  // and is deliberately not affected.
  if (existing.status === "confirmed") {
    console.log("Skipping update: event is confirmed by a human");

    return existing;
  }

  const { changes, isRescheduled } = detectChanges(existing, incoming);

  if (changes.length === 0) {
    return existing;
  }

  const existingConfidence = existing.confidence ?? 0;
  const newConfidence = incoming.confidence ?? 0;

  console.log("UPDATE CHECK:", {
    existing: existingConfidence,
    incoming: newConfidence,
  });

  // CORE RULE
  if (newConfidence < existingConfidence) {
    console.log("Skipping update due to lower confidence");

    return existing; // stop update
  }

  // Prepare update data
  const updateData: any = {};

  if (changes.some((c) => c.field === "date")) {
    updateData.date = toUTCDate(incoming.date);
  }

  if (changes.some((c) => c.field === "time")) {
    updateData.time = incoming.time;
  }

  if (changes.some((c) => c.field === "venue")) {
    updateData.venue = incoming.venueMeta?.isExplicit
      ? incoming.venueMeta.value
      : (incoming.venue ?? null);
  }

  // RESCHEDULE LOGIC
  if (isRescheduled) {
    updateData.status = "rescheduled";

    updateData.eventKey = generateEventKey({
      company: existing.company,
      stage: existing.stage,
      date: incoming.date,
    });
  }

  return prisma.$transaction(async (tx) => {
    // Store change history
    for (const change of changes) {
      await tx.eventUpdate.create({
        data: {
          eventId,
          // Owner carried onto the history row. It must equal the Event's
          // owner: AC-5.11 attaches a composite foreign key to
          // Event(id, userId) that makes any other value unrepresentable
          // (RFC-001 §12.3).
          userId: owner.userId,
          field: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
        },
      });
    }

    // Update event.
    //
    // Scoped by (id, userId) through the `@@unique([id, userId])` composite
    // selector, so the tenant predicate is part of the statement that finds the
    // row rather than a property of the caller that supplied the id.
    //
    // The write was already unreachable for a wrong owner — the history insert
    // above references Event(id, userId) and fails first, taking the whole
    // transaction with it. But that protection lives on another table and holds
    // only while every automated Event write records history alongside it. The
    // predicate belongs here, on the write it protects, before the first
    // automated write that does not.
    return tx.event.update({
      where: {
        id_userId: {
          id: eventId,
          userId: owner.userId,
        },
      },
      data: {
        ...updateData,
        confidence: newConfidence,
      },
    });
  });
};

export const detectChanges = (existing: any, incoming: any) => {
  const changes = [];
  let isRescheduled = false;

  // DATE
  const existingDateKey = toISTKey(existing.date);
  const incomingDateKey = toISTKey(toUTCDate(incoming.date));

  if (existingDateKey !== incomingDateKey) {
    changes.push({
      field: "date",
      oldValue: existingDateKey,
      newValue: incomingDateKey,
    });

    isRescheduled = true;
  }

  // TIME
  if (
    incoming.time !== undefined &&
    incoming.time !== null &&
    existing.time !== incoming.time
  ) {
    changes.push({
      field: "time",
      oldValue: existing.time || "null",
      newValue: incoming.time || "null",
    });
  }

  // VENUE
  // When the email explicitly mentions a venue keyword, treat even a null result as a change
  // (e.g. "venue: PFA seating plan" → value=null, isExplicit=true → clears existing venue).
  // When there is no explicit mention, never overwrite what's already stored.
  const venueMeta = incoming.venueMeta;
  if (venueMeta?.isExplicit) {
    const incomingValue = venueMeta.value ?? null;
    if (existing.venue !== incomingValue) {
      changes.push({
        field: "venue",
        oldValue: existing.venue ?? "null",
        newValue: incomingValue ?? "null",
      });
    }
  } else if (incoming.venue != null && existing.venue !== incoming.venue) {
    changes.push({
      field: "venue",
      oldValue: existing.venue ?? "null",
      newValue: incoming.venue,
    });
  }

  return { changes, isRescheduled };
};

// GET EVENTS
//
// Each Event carries a derived `temporalStatus` (see `classifyTemporalStatus`).
// It is attached on the way out rather than stored, so the category is always a
// statement about now and never a stale column; the query, the tenant predicate
// and the ordering are untouched.
//
// One `now` classifies the whole list, so two Events either side of a boundary
// cannot be judged against different instants within a single response.
export const getEventsService = async (
  owner: OwnershipContext,
  { status }: { status?: string },
) => {
  const where: any = { userId: owner.userId };

  if (status) where.status = status;

  const events = await prisma.event.findMany({
    where,
    orderBy: { confidence: "asc" }, // low confidence first
  });

  const now = new Date();

  return events.map((event) => ({
    ...event,
    temporalStatus: classifyTemporalStatus(event, now),
  }));
};

// GET SINGLE EVENT
//
// `findFirst` with a tenant predicate rather than `findUnique` by id. The
// difference is the point: a `findUnique` returns another User's Event and
// leaves the caller to remember to check, which is the kind of check that is
// eventually forgotten. Here an Event owned by someone else is simply not found,
// and the caller cannot distinguish that from a non-existent id — which is what
// RFC-001 §9.4 requires of the response.
export const getEventByIdService = async (
  owner: OwnershipContext,
  id: number,
) => {
  return prisma.event.findFirst({
    where: { id, userId: owner.userId },
  });
};

// MANUAL UPDATE (REVIEW FIX)
//
// Returns null when the Event does not exist or belongs to another User, so the
// controller answers 404 in both cases.
//
// Ownership is verified in a separate read rather than folded into the update,
// because `update` requires a unique predicate and `id` alone is the only unique
// key available until AC-5.11 adds `@@unique([userId, eventKey])`. The window
// between the two statements is not exploitable: ownership is immutable once
// written, so it cannot change between the check and the write.
// The update payload is built field by field from `ManualEventUpdate` rather
// than spread from the caller's object. The spread was the mass-assignment
// defect: every Event column is a legal Prisma input, so `{ ...data }` handed
// the caller `userId`, `id`, `eventKey`, and the provenance timestamps along
// with the two fields they were meant to edit.
//
// Constructing the payload explicitly makes that impossible by construction
// rather than by filtering: a field that is not written here cannot be written
// through this path, whatever an internal caller passes. The narrow parameter
// type is the compile-time half of the same guarantee.
export const updateEventManuallyService = async (
  owner: OwnershipContext,
  id: number,
  data: ManualEventUpdate,
) => {
  const existing = await prisma.event.findFirst({
    where: { id, userId: owner.userId },
    select: { id: true },
  });

  if (!existing) {
    return null;
  }

  return prisma.event.update({
    where: { id },
    data: {
      ...(data.company !== undefined && { company: data.company }),
      ...(data.stage !== undefined && { stage: data.stage }),
      confidence: 1.0, // human override
      status: "confirmed", // review → confirmed
      reviewReason: null,
    },
  });
};
