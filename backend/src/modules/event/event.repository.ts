import { prisma } from "../../lib/prisma";
import type { CreateEventInput } from "./event.types";

export const createEvent = async (data: CreateEventInput, eventKey: string) => {
  return prisma.event.create({
    data: {
      company: data.company,
      stage: data.stage,
      date: new Date(data.date),
      eventKey, // ✅ use passed value
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