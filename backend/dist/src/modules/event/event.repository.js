import { prisma } from "../../lib/prisma.js";
import { subDays, addDays } from "date-fns";
export const createEvent = async (data, eventKey) => {
    const existing = await prisma.event.findUnique({
        where: {
            eventKey,
        },
    });
    if (existing) {
        return existing;
    }
    return prisma.event.create({
        data: {
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
export const findByEventKey = async (eventKey) => {
    return prisma.event.findUnique({
        where: { eventKey },
    });
};
export const updateEvent = async (id, data) => {
    return prisma.event.update({
        where: { id },
        data,
    });
};
export const formatDate = (date) => {
    return date.toISOString().split("T")[0]; // YYYY-MM-DD
};
export const formatDateIndia = (date) => {
    return new Intl.DateTimeFormat("en-IN", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        timeZone: "Asia/Kolkata", // Forces Indian Standard Time
    }).format(date);
};
export const findSimilarEvent = async (company, stage, date) => {
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
export const findNearbyEvents = async ({ company, date, windowDays, }) => {
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
export const findByCompanyAndStage = async ({ company, stage, }) => {
    return prisma.event.findMany({
        where: {
            company: company,
            stage: stage,
        },
    });
};
//# sourceMappingURL=event.repository.js.map