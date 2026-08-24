import { prisma } from "../../lib/prisma.js";
import type { CreateEventInput } from "./event.types.js";
import type { OwnershipContext } from "../auth/tenant-context.js";
import { subDays, addDays } from "date-fns";

type NearbyEventsInput = {
  company: string;
  date: string;
  windowDays: number;
};

type CompanyStageEventsInput = {
  company: string;
  stage: string;
  date: string;
  windowDays: number;
};

// TENANT SCOPING (RFC-001 §7.4).
//
// Every candidate query below is bounded by owner. This changes which records
// exist as far as recognition is concerned; it does not change how recognition
// decides. ADR-006's admission-then-ranking model, the identity gate, the
// tiers, and the thresholds are untouched — a record belonging to another User
// is not a rejected candidate, it is not a candidate, because it was never a
// proposition about this User's world.
//
// `userId: null` compiles to `IS NULL`, so unowned records form their own
// tenant and match only each other. That is exactly the behaviour that existed
// before ownership was introduced, which is why pre-existing data keeps
// recognising itself.

// Shape of a Prisma known-request error, checked structurally rather than
// with `instanceof Prisma.PrismaClientKnownRequestError`. That check needs
// the real error class from the generated client at runtime, and this
// module is imported by call paths (the HTTP controller, tests) that have no
// reason to load Prisma's generated runtime just to construct an error
// object. A structural check works identically for a real Prisma error and
// costs nothing extra to import.
type PrismaKnownRequestError = {
  code: string;
  meta?: { target?: unknown };
};

const isPrismaKnownRequestError = (
  error: unknown,
): error is PrismaKnownRequestError =>
  typeof error === "object" &&
  error !== null &&
  typeof (error as { code?: unknown }).code === "string";

// A P2002 whose `target` names the `(userId, eventKey)` constraint, as
// opposed to some other unique constraint the insert below could in
// principle violate. Modelled as an array-of-field-names check because
// that is the shape Postgres/Prisma report for this constraint elsewhere in
// this codebase (see extraction.repository.ts's upsert and its test).
const isEventKeyConflict = (error: unknown): boolean => {
  if (!isPrismaKnownRequestError(error) || error.code !== "P2002") {
    return false;
  }

  const target = error.meta?.target;

  return (
    Array.isArray(target) &&
    target.includes("userId") &&
    target.includes("eventKey")
  );
};

export const createEvent = async (
  owner: OwnershipContext,
  data: CreateEventInput,
  eventKey: string,
) => {
  // `eventKey` is unique per owner, not globally — AC-5.11 replaced the
  // global unique index with `@@unique([userId, eventKey])` (RFC-001 §7.4),
  // so two students receiving the same placement broadcast produce the same
  // key and still get two distinct Events. `findUnique` on the composite
  // selector is therefore a real unique lookup, not an approximation of one.
  const existing = await prisma.event.findUnique({
    where: {
      userId_eventKey: {
        userId: owner.userId,
        eventKey,
      },
    },
  });

  if (existing) {
    return existing;
  }

  try {
    return await prisma.event.create({
      data: {
        userId: owner.userId,
        company: data.company,
        stage: data.stage,
        date: new Date(data.date),
        time: data.time ?? null,
        venue: data.venue ?? null,
        eventKey, // use passed value
        confidence: data.confidence ?? 0,
        status: data.status ?? "scheduled",
        reviewReason: data.reviewReason ?? null,
      },
    });
  } catch (error) {
    // The lookup above and this insert are two separate statements with a
    // window between them, so a concurrent execution (e.g. a stalled BullMQ
    // job replaying alongside the original attempt) can pass the lookup and
    // still lose the race here. The database is the concurrency authority:
    // on a conflict on THIS constraint specifically, the other execution's
    // row is the correct answer, so re-read and return it instead of
    // failing the job. Any other P2002 is a different conflict entirely and
    // must not be swallowed by this recovery.
    if (isEventKeyConflict(error)) {
      const raced = await prisma.event.findUnique({
        where: {
          userId_eventKey: {
            userId: owner.userId,
            eventKey,
          },
        },
      });

      if (raced) {
        return raced;
      }
    }

    throw error;
  }
};

export const findByEventKey = async (
  owner: OwnershipContext,
  eventKey: string,
) => {
  return prisma.event.findFirst({
    where: { eventKey, userId: owner.userId },
  });
};

// Currently uncalled, kept ownership-aware rather than left global. An unscoped
// mutator sitting in a repository is a footgun aimed at whoever revives it: the
// tenant predicate has to be there before the first caller, not after.
//
// `updateMany` because `update` demands a unique predicate and `id` is the only
// unique key until AC-5.11. It returns a count, so a caller can tell a refused
// cross-tenant write from an applied one.
export const updateEvent = async (
  owner: OwnershipContext,
  id: number,
  data: any,
) => {
  return prisma.event.updateMany({
    where: { id, userId: owner.userId },
    data,
  });
};

export const formatDate = (date: Date) => {
  return date.toISOString().split("T")[0]; // YYYY-MM-DD
};

export const formatDateIndia = (date: Date) => {
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Kolkata", // Forces Indian Standard Time
  }).format(date);
};

export const findSimilarEvent = async (
  owner: OwnershipContext,
  company: string,
  stage: string,
  date: Date,
) => {
  const start = new Date(date);
  start.setDate(start.getDate() - 1);

  const end = new Date(date);
  end.setDate(end.getDate() + 1);

  return prisma.event.findFirst({
    where: {
      userId: owner.userId,
      company: {
        equals: company,
        mode: "insensitive",
      },
      stage,
      date: {
        gte: start,
        lte: end,
      },
    },
  });
};

export const findNearbyEvents = async (
  owner: OwnershipContext,
  { company, date, windowDays }: NearbyEventsInput,
) => {
  const parsedDate = new Date(date);
  return prisma.event.findMany({
    where: {
      userId: owner.userId,
      company: company,
      date: {
        gte: subDays(parsedDate, windowDays),
        lte: addDays(parsedDate, windowDays),
      },
    },
  });
};

// Candidates for the loose recognition tier. `date` and `windowDays` are
// required: an unbounded company+stage lookup lets that tier match events months
// apart, which the update path then applies as a reschedule (AC-1 / D-2). Making
// the bound part of the signature stops a caller reintroducing the unbounded
// query by omission.
export const findByCompanyAndStage = async (
  owner: OwnershipContext,
  { company, stage, date, windowDays }: CompanyStageEventsInput,
) => {
  const parsedDate = new Date(date);

  return prisma.event.findMany({
    where: {
      userId: owner.userId,
      company: company,
      stage: stage,
      date: {
        gte: subDays(parsedDate, windowDays),
        lte: addDays(parsedDate, windowDays),
      },
    },
  });
};
