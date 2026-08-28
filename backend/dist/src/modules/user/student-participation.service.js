import { getStudentProfileByUserId } from "./user.repository.js";
import { getShortlistIntelligenceForUser } from "../document-intelligence/shortlist.repository.js";
import { participantsInclude } from "../document-intelligence/participant-matching.js";
/* `participantInformation` is a JSON column, so what comes back is `unknown`
 * until proven otherwise. Read defensively rather than cast: the value was
 * written by a model-driven extractor and may be absent, an empty object, or a
 * shape from an older run. A malformed document must yield "no match", never a
 * thrown request. */
const participantsOf = (stored) => {
    if (typeof stored !== "object" || stored === null) {
        return [];
    }
    const participants = stored.participants;
    if (!Array.isArray(participants)) {
        return [];
    }
    return participants.filter((entry) => typeof entry === "object" &&
        entry !== null &&
        typeof entry.attributes === "object" &&
        entry.attributes !== null);
};
export const getShortlistParticipationService = async (context) => {
    const profile = await getStudentProfileByUserId(context.userId);
    const registrationNumber = profile?.registrationNumber ?? null;
    /* No number means no question to ask, and the shortlists are not read at all.
       Short-circuiting here is not merely an optimisation: a student who has not
       supplied a number has not asked to be looked up, and this feature must stay
       as optional as the field it depends on. */
    if (registrationNumber === null || registrationNumber.trim() === "") {
        return {
            registrationNumber,
            shortlistsChecked: 0,
            appearsOn: [],
        };
    }
    const shortlists = await getShortlistIntelligenceForUser(context);
    const appearsOn = shortlists
        .filter((shortlist) => participantsInclude(participantsOf(shortlist.participantInformation), registrationNumber))
        .map((shortlist) => ({ attachmentId: shortlist.attachmentId }));
    return {
        registrationNumber,
        shortlistsChecked: shortlists.length,
        appearsOn,
    };
};
//# sourceMappingURL=student-participation.service.js.map