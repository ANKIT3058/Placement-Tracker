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

export const createEvent = async (
  owner: OwnershipContext,
  data: CreateEventInput,
  eventKey: string,
) => {
  // `findFirst`, not `findUnique`: `eventKey` is still globally unique, so it
  // cannot be queried together with `userId` through the unique index. AC-5.11
  // replaces that constraint with `@@unique([userId, eventKey])`, at which point
  // this becomes a unique lookup again. Until then, scoping here is what stops
  // one User's create from returning another User's Event.
  const existing = await prisma.event.findFirst({
    where: {
      eventKey,
      userId: owner.userId,
    },
  });

  if (existing) {
    return existing;
  }
  return prisma.event.create({
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
};

export const findByEventKey = async (
  owner: OwnershipContext,
  eventKey: string,
) => {
  return prisma.event.findFirst({
    where: { eventKey, userId: owner.userId },
  });
};

export const updateEvent = async (id: number, data: any) => {
  return prisma.event.update({
    where: { id },
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
