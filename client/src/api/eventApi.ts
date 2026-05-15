const BASE_URL = import.meta.env.VITE_API_URL;

export const getEvents = async () => {
  const res = await fetch(`${BASE_URL}/event`);
  return res.json();
};

export const updateEvent = async (id: number, data: any) => {
  const res = await fetch(`${BASE_URL}/event/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
  return res.json();
};
