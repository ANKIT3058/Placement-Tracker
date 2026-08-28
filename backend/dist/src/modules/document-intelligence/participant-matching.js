/* Deciding whether a stored registration number appears among a document's
 * participants (G-8.4).
 *
 * THIS IS THE ENTITY-RESOLUTION LAYER `participant-information.types` deferred.
 * That file models a participant as an open bag of attributes keyed by "the
 * document's own column/field label", deliberately refusing a Student model, and
 * says normalization belongs to "a later, dedicated layer once real participant
 * modeling is introduced". This is that layer, kept as narrow as the question
 * being asked: does THIS user's number appear in THIS list, yes or no.
 *
 * Pure by construction — no database, no session, no I/O. Every rule below is a
 * decision about strings, so it is decided once, here, and tested directly.
 *
 * NOTHING HERE IS AN AUTHORIZATION DECISION. A match says "your number appears
 * in this document"; it never says what a caller may see. Ownership is `User.id`
 * and is enforced by the query that selects which documents reach this code at
 * all.
 */
/* Registration-like attribute keys, as an ALLOWLIST.
 *
 * Arbitrary attributes are never scanned. A shortlist may pair a roll number
 * with a seat, a phone number, a rank or a percentage, and treating "any value
 * that happens to equal the user's number" as participation would find matches
 * in fields that mean something else entirely — a seat number colliding with a
 * registration number is a coincidence, not evidence.
 *
 * Compared after `normalizeKey` below, so each entry stands for a family of
 * spellings rather than one literal header: "rollno" recognises "Roll No",
 * "roll_no", "ROLL-NO." and "Roll  Number" alike. That normalization applies to
 * the KEY only. Values are never rewritten.
 */
const REGISTRATION_KEYS = new Set([
    "rollno",
    "rollnumber",
    "roll",
    "regno",
    "regnumber",
    "registrationno",
    "registrationnumber",
    "registration",
    "enrollmentno",
    "enrollmentnumber",
    "enrollment",
    "enrolmentno",
    "enrolmentnumber",
    "enrolment",
    "universityrollno",
    "universityrollnumber",
    "studentid",
    "studentno",
    "studentnumber",
]);
/* A header reduced to its comparable core: lower-cased, with everything that is
 * not a letter or digit removed.
 *
 * Deliberately aggressive, because it operates on a LABEL a human typed into a
 * spreadsheet — "Reg. No", "reg_no", "Registration Number" and "REGNO" are the
 * same column, and a rule that treated them as four different ones would fail
 * for reasons that have nothing to do with the student.
 *
 * The same aggression would be wrong on a value, which is why it is never
 * applied to one.
 */
const normalizeKey = (key) => key.toLowerCase().replace(/[^a-z0-9]/g, "");
/* Are two registration numbers the same number?
 *
 * TRIM AND CASE ONLY. Surrounding whitespace is invisible in a spreadsheet cell,
 * and a document that writes `2023abcd` means the same student as one that
 * writes `2023ABCD`. Both are safe to ignore.
 *
 * PUNCTUATION IS NOT REMOVED, and that is a deliberate limit rather than an
 * oversight. `BTECH/2023/42` and `BTECH-2023-42` may well be one student, but
 * they may equally be two different institutional formats — and stripping
 * separators would also make `2023-1` equal `20231`, which is a different
 * student. Declining to guess is the recoverable failure: a missed match tells
 * the user nothing, while a false one tells them they are shortlisted when they
 * are not.
 *
 * The STORED value is never altered by any of this. This function compares
 * copies; `StudentProfile.registrationNumber` keeps exactly the bytes the
 * student typed.
 */
const sameNumber = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
/* The registration-like values one participant carries, in the order the
 * document listed them. Usually zero or one; more than one is the case the
 * conflict rule exists for. */
const registrationValuesOf = (participant) => {
    const values = [];
    for (const [key, value] of Object.entries(participant.attributes ?? {})) {
        if (typeof value !== "string") {
            continue;
        }
        if (!REGISTRATION_KEYS.has(normalizeKey(key))) {
            continue;
        }
        // An empty or whitespace-only cell identifies nobody.
        if (value.trim() === "") {
            continue;
        }
        values.push(value);
    }
    return values;
};
/* Does this participant carry the given registration number?
 *
 * CONFLICTING VALUES MEAN UNMATCHED, ALWAYS. A row carrying two
 * registration-like columns that disagree — say `roll_no: 20231234` beside
 * `reg_no: 20239999` — is a row this layer cannot read confidently. It might be
 * a merged spreadsheet, a mis-parsed table, or two genuinely different fields.
 * Matching on whichever one happened to agree with the user would be a guess,
 * and the harm of guessing wrong here is telling a student they are shortlisted
 * when they are not. So the row is skipped, even when one of its values matches.
 *
 * Values that agree with each other are not a conflict: one student's number
 * repeated under two headers is one number.
 */
export const participantMatches = (participant, registrationNumber) => {
    const values = registrationValuesOf(participant);
    if (values.length === 0) {
        return false;
    }
    const [first, ...rest] = values;
    if (rest.some((value) => !sameNumber(value, first))) {
        return false;
    }
    return sameNumber(first, registrationNumber);
};
/* Does this document list the given registration number?
 *
 * The whole public answer of this module, and deliberately a boolean: the
 * question G-8.4 asks is "am I on this list", not "who else is". No participant,
 * no attribute and no other student's value is returned or exposed.
 */
export const participantsInclude = (participants, registrationNumber) => {
    // An unset or blank number matches nothing. Guarded here as well as at the
    // call site because a blank string would otherwise compare equal to any blank
    // cell the trim above did not already exclude.
    if (registrationNumber.trim() === "") {
        return false;
    }
    return participants.some((participant) => participantMatches(participant, registrationNumber));
};
//# sourceMappingURL=participant-matching.js.map