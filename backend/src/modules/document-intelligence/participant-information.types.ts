// Participant-specific content a document conveys about the people involved in a
// placement — the counterpart to EventInformation, which describes the event.
//
// This is intentionally NOT a Student/Candidate model. Documents describe people
// in wildly different, inconsistent ways: a seating arrangement pairs a name
// with a seat and room; a shortlist pairs a roll number with a status; an
// interview panel lists interviewer names and specializations. Committing to a
// concrete student schema now would either be wrong for most of those or force
// every future document type to squeeze into fields that do not fit.
//
// So a participant is modeled as an open bag of string attributes whose keys are
// whatever the source document used. This keeps the domain honest ("we captured
// these labelled values") and leaves normalization/entity-resolution to a later,
// dedicated layer once real participant modeling is introduced.

// A single person (or party) mentioned by a document, described generically.
export interface Participant {
  // The labelled values the document associated with this participant, keyed by
  // the document's own column/field label (e.g. "roll_no", "seat", "status").
  // Both keys and values are strings — this layer records what was said, it does
  // not interpret or type it.
  attributes: Record<string, string>;
}

// The full set of participants a document describes, kept as a flat list because
// the meaning of the grouping (seating vs shortlist vs panel) is already carried
// by the document's DocumentType classification — it need not be re-encoded here.
export interface ParticipantInformation {
  participants: Participant[];
}
