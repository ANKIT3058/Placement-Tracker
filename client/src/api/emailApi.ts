const BASE_URL = "/api";

export const processEmail = async (text: string) => {
  const res = await fetch(`${BASE_URL}/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body: text }),
  });

  return res.json();
};
