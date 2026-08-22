import { toISTKey } from "../../shared/utils/date.js";
import { TEMPORAL_STATUS, type TemporalStatus } from "./event.types.js";

export const generateEventKey = (data: {
  company: string;
  stage: string;
  date: string;
}) => {
  return `${data.company}|${data.stage}|${data.date}`;
};

// The fields temporal classification reads. Narrower than Event on purpose: the
// category depends on these three and the clock, and nothing else.
type TemporalFields = {
  date: Date;
  time: string | null;
  isTimeEstimated: boolean;
};

// "HH:MM" / "H:MM" with a real hour and minute. A `time` that does not parse is
// not a clock time, so it cannot expire anything — see `isReliablyTimed`.
const CLOCK_TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

// India observes no DST, so its offset is a constant. This is the same fixed
// +5:30 the existing `formatDateISTKey` applies; no new timezone machinery is
// introduced.
const IST_UTC_OFFSET = "+05:30";

// A time may drive expiry only when the document actually stated one.
//
// `isTimeEstimated` marks a time the extractor inferred from a vague phrase —
// `detectEstimatedTime` sets it when the text matched around/approx/morning/
// afternoon/evening, so "morning" may have become "09:30". Treating that as the
// moment the event ends would hide a real event on the strength of a guess, so
// an estimated time is treated as no time at all. An unparseable time is
// handled the same way, for the same reason: absence of a usable clock value
// must never be read as evidence that the event is over.
const isReliablyTimed = (event: TemporalFields): event is TemporalFields & {
  time: string;
} =>
  event.time !== null && !event.isTimeEstimated && CLOCK_TIME.test(event.time);

// The instant a reliably-timed Event begins.
//
// `date` is stored as UTC midnight standing in for a calendar day, so the day is
// recovered in IST first (`toISTKey`) and the stated clock time is then attached
// to it as an IST wall time. Combining the raw UTC instant with the time
// directly would shift the day for any event whose IST day differs from its UTC
// day, which is every event between 00:00 and 05:30 IST.
const occurrenceInstant = (event: TemporalFields & { time: string }): Date =>
  new Date(`${toISTKey(event.date)}T${event.time}:00${IST_UTC_OFFSET}`);

// Where this Event sits relative to `now`.
//
//   reliably timed → expired once the scheduled instant has arrived
//                    (`now >= occurrence`: the event has begun, so it is no
//                    longer something to be reminded is coming)
//   otherwise      → expired once its IST calendar day has ended, so a
//                    date-only Event stays upcoming for the whole day
//
// `now` is a parameter rather than read inside, which keeps the function pure
// and lets one instant classify a whole list consistently.
export const classifyTemporalStatus = (
  event: TemporalFields,
  now: Date,
): TemporalStatus => {
  if (isReliablyTimed(event)) {
    return now.getTime() >= occurrenceInstant(event).getTime()
      ? TEMPORAL_STATUS.EXPIRED
      : TEMPORAL_STATUS.UPCOMING;
  }

  // Both keys are `YYYY-MM-DD` in IST, so a string comparison is a calendar-day
  // comparison.
  return toISTKey(event.date) < toISTKey(now)
    ? TEMPORAL_STATUS.EXPIRED
    : TEMPORAL_STATUS.UPCOMING;
};
