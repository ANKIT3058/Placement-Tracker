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
export {};
//# sourceMappingURL=participant-information.types.js.map