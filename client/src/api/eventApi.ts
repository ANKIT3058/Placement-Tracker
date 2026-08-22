import type { Event, ManualEventUpdate } from "../types/event";
import { requestJson } from "./http";

const BASE_URL = import.meta.env.VITE_API_URL;

export const getEvents = async (): Promise<Event[]> => {
  return requestJson<Event[]>(`${BASE_URL}/event`);
};

export const updateEvent = async (id: number, data: ManualEventUpdate) => {
  return requestJson(`${BASE_URL}/event/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
};
