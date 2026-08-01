// The semantic category a placement document falls into once it has been
// understood (NOT how it was parsed). This is the vocabulary the Document
// Intelligence layer speaks in: a parser turns bytes into a ParsedAttachment,
// and document understanding turns that into one of these classifications.
//
// Modeled as a frozen const object plus a derived union type — the same pattern
// used elsewhere in the codebase (see ATTACHMENT_STATUS) — rather than a TS
// `enum`. It gives an ergonomic value namespace (DOCUMENT_TYPE.SHORTLIST), a
// structural string-literal type usable across module boundaries, and no
// runtime/emit surprises under NodeNext.
export const DOCUMENT_TYPE = {
    // A role/company posting: eligibility, CTC, responsibilities, apply-by dates.
    JOB_DESCRIPTION: "job_description",
    // A timetable of rounds/slots (e.g. interview or test schedule).
    INTERVIEW_SCHEDULE: "interview_schedule",
    // Free-form guidance addressed to participants (dress code, reporting rules).
    GENERAL_INSTRUCTIONS: "general_instructions",
    // A room/seat allocation for a test or interview.
    SEATING_ARRANGEMENT: "seating_arrangement",
    // A list of participants advanced to a stage.
    SHORTLIST: "shortlist",
    // Final or intermediate outcomes (selected / rejected / on-hold).
    RESULT: "result",
    // Understood, but does not fit any known category. The safe default whenever
    // classification is uncertain — never guess a specific type.
    UNKNOWN: "unknown",
};
//# sourceMappingURL=document-type.js.map