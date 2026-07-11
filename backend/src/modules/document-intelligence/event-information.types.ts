// The subset of a document's meaning that is capable of modifying an Event.
//
// Every field here corresponds one-to-one to a mutable field on the Event
// domain concept (company, stage, date, time, venue). Nothing else belongs in
// this type: identifiers, status, confidence and persistence concerns live with
// the Event itself, not with a document's understanding of it. Keeping the shape
// this narrow means a consumer can apply EventInformation to an Event field by
// field without re-deciding what an event "is".
//
// Every field is optional on purpose: a single document rarely reveals all of
// them (a venue notice carries a venue but no company; a schedule carries a date
// but no venue). An absent field means "this document said nothing about it" —
// NOT "clear this value" — so downstream update logic treats undefined as
// leave-unchanged.
//
// This type is deliberately independent of how the values will be stored: it
// describes what a document means, not a database row.
export interface EventInformation {
  // The hiring company/organization the document concerns.
  company?: string;

  // The placement stage the document concerns (e.g. a test, a round).
  stage?: string;

  // The calendar date the document assigns to the event.
  date?: Date;

  // The time-of-day the document assigns, kept as text because documents
  // express it in many non-normalized forms ("10 AM", "morning slot").
  time?: string;

  // Where the event takes place (hall, room, campus, online link).
  venue?: string;
}
