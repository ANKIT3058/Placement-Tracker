const BASE_URL = import.meta.env.VITE_API_URL;

/* The manual page collects a single textarea of raw email text, but POST /email
   requires `subject`, `body` and `sender` together — `Email.subject` and
   `Email.sender` are NOT NULL, so the route cannot accept a body on its own and
   answers 400 "Missing required fields" when one is absent.

   Neither field reaches extraction: the pipeline reads `body` and nothing else
   (email.service.ts). They are provenance, not content, so they are filled with
   constants that mark the row as manually pasted rather than synced from a
   mailbox. */
const MANUAL_SUBJECT = "Manual paste";
const MANUAL_SENDER = "manual@placement-tracker.local";

export const processEmail = async (text: string) => {
  const res = await fetch(`${BASE_URL}/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      subject: MANUAL_SUBJECT,
      body: text,
      sender: MANUAL_SENDER,
    }),
  });

  return res.json();
};
