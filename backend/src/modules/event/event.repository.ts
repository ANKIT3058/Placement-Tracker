import { prisma } from "../../lib/prisma";
import type { CreateEventInput } from "./event.types";
import { subDays, addDays } from "date-fns";

type NearbyEventsInput = {
  company: string;
  date: string;
  windowDays: number;
};

export const createEvent = async (data: CreateEventInput, eventKey: string) => {
  return prisma.event.create({
    data: {
      company: data.company,
      stage: data.stage,
      date: new Date(data.date),
      time: data.time ?? null,
      venue: data.venue ?? null,
      eventKey, // use passed value
    },
  });
};

export const findByEventKey = async (eventKey: string) => {
  return prisma.event.findUnique({
    where: { eventKey },
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

export const findNearbyEvents = async ({
  company,
  date,
  windowDays,
}: NearbyEventsInput) => {
  const parsedDate = new Date(date);
  return prisma.event.findMany({
    where: {
      company: company,
      date: {
        gte: subDays(parsedDate, windowDays),
        lte: addDays(parsedDate, windowDays),
      },
    },
  });
};

export const findByCompanyAndStage = async ({
  company,
  stage,
}: {
  company: string;
  stage: string;
}) => {
  return prisma.event.findMany({
    where: {
      company: company,
      stage: stage,
    },
  });
};
