import { prisma } from "../../lib/prisma";
import {
  createEvent,
  updateEvent as updateEventRepo,
} from "./event.repository";

import { generateEventKey } from "./event.utils";
import { toUTCDate, toISTKey } from "../../shared/utils/date";
import type { CreateEventInput } from "./event.types";

// CREATE
export const createEventService = async (data: CreateEventInput) => {
  const eventKey = generateEventKey({
    company: data.company,
    stage: data.stage,
    date: data.date,
  });

  return createEvent(data, eventKey);
};

// UPDATE
export const updateEventService = async (
  eventId: number,
  existing: any,
  incoming: CreateEventInput,
) => {
  const { changes, isRescheduled } = detectChanges(existing, incoming);

  if (changes.length === 0) {
    return existing;
  }

  // Store change history
  for (const change of changes) {
    await prisma.eventUpdate.create({
      data: {
        eventId,
        field: change.field,
        oldValue: change.oldValue,
        newValue: change.newValue,
      },
    });
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
    // If explicit, write the exact value (may be null → clears the column).
    // Otherwise the change was detected via the non-null fallback path, so use incoming.venue.
    updateData.venue = incoming.venueMeta?.isExplicit
      ? incoming.venueMeta.value
      : (incoming.venue ?? null);
  }

  // RESCHEDULE LOGIC
  if (isRescheduled) {
    updateData.status = "rescheduled";

    // regenerate eventKey
    updateData.eventKey = generateEventKey({
      company: existing.company,
      stage: existing.stage,
      date: incoming.date,
    });
  }

  return updateEventRepo(eventId, updateData);
};

const detectChanges = (existing: any, incoming: any) => {
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
