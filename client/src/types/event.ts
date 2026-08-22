/* One Event exactly as `GET /event` returns it.
   The endpoint serialises raw rows, so this mirrors the persisted
   columns the frontend consumes — declared in one place so a field the
   backend already sends can no longer go unnoticed by every component
   at once. Timestamps arrive as ISO strings because they cross JSON. */
export interface Event {
  id: number;
  company: string;
  stage: string;

  /* Calendar date only, persisted as UTC midnight — it carries no clock
     time. Anything read out of its hours/minutes is an artefact of the
     viewer's timezone, not data. The real time is the field below. */
  date: string;

  /* 24-hour "HH:MM". Null when the email carried no time at all. */
  time: string | null;

  /* True when the extractor inferred the time rather than reading it
     (e.g. "morning" → "10:00"). */
  isTimeEstimated: boolean;

  venue: string | null;
  confidence: number;
  status: string;

  /* Where this event sits relative to now, decided by the backend from
     date, time and isTimeEstimated against an authoritative clock in
     IST. Required, not optional: every event the API returns carries it,
     and making it optional would invite a caller to fall back to reading
     the date — which is the timezone-dependent guess the server-side
     derivation exists to replace. */
  temporalStatus: "upcoming" | "expired";
  reviewReason: string | null;

  createdAt: string;
  updatedAt: string;
}
