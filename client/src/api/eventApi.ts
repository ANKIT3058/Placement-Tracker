import type { Event } from "../types/event";

const BASE_URL = import.meta.env.VITE_API_URL;

export const getEvents = async (): Promise<Event[]> => {
  const res = await fetch(`${BASE_URL}/event`);
  return res.json();
};

export const updateEvent = async (id: number, data: Partial<Event>) => {
  const res = await fetch(`${BASE_URL}/event/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
  return res.json();
};
