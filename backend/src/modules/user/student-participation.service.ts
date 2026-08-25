import { getStudentProfileByUserId } from "./user.repository.js";
import { getShortlistIntelligenceForUser } from "../document-intelligence/shortlist.repository.js";
import { participantsInclude } from "../document-intelligence/participant-matching.js";
import type { Participant } from "../document-intelligence/participant-information.types.js";
import type { TenantContext } from "../auth/tenant-context.js";

/* "Am I on this shortlist?" — the question the participant extractor was built
 * to answer (G-8.4).
 *
 * Until now the registration number was stored and read by nothing, and
 * `participantInformation` was written and read by nothing. This joins the two:
 * it is the first consumer of either, and it is a DERIVATION — it reads facts
 * already persisted and computes an answer. It writes nothing, anywhere.
 *
 * OWNERSHIP IS `User.id`, AND THE REGISTRATION NUMBER IS NOT AN AUTHORIZATION
 * BOUNDARY. The set of documents considered is decided entirely by the
 * tenant-scoped query below; the registration number then decides which of THOSE
 * the user appears in. A user with no number, or a wrong one, sees fewer
 * results — never someone else's documents. The two mechanisms answer different
 * questions and must never be confused: one is "may I see this", the other is
 * "does this mention me".
 *
 * NOTHING ABOUT OTHER PARTICIPANTS LEAVES THIS MODULE. A shortlist lists other
 * students by name and roll number; the result below carries an attachment id
 * and a boolean's worth of information about the caller, and no attribute of any
 * participant — including the caller's own.
 */

// What the caller is told. `attachmentId` names one of the caller's own
// attachments, which they already own; nothing else about the document is
// included.
export type ShortlistAppearance = {
  attachmentId: number;
};

export type ShortlistParticipation = {
  /* Echoed so the caller can tell "you appear on none" apart from "we could not
     look, because you have not set a number". Those are different answers and a
     bare empty list conflates them. */
  registrationNumber: string | null;

  /* How many of the caller's own shortlists were examined. Also there to keep an
     empty result honest: zero checked means there was nothing to find, while
     five checked means the number genuinely did not appear. */
  shortlistsChecked: number;

  appearsOn: ShortlistAppearance[];
};

/* `participantInformation` is a JSON column, so what comes back is `unknown`
 * until proven otherwise. Read defensively rather than cast: the value was
 * written by a model-driven extractor and may be absent, an empty object, or a
 * shape from an older run. A malformed document must yield "no match", never a
 * thrown request. */
const participantsOf = (stored: unknown): Participant[] => {
  if (typeof stored !== "object" || stored === null) {
    return [];
  }

  const participants = (stored as { participants?: unknown }).participants;

  if (!Array.isArray(participants)) {
    return [];
  }

  return participants.filter(
    (entry): entry is Participant =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { attributes?: unknown }).attributes === "object" &&
      (entry as { attributes?: unknown }).attributes !== null,
  );
};

export const getShortlistParticipationService = async (
  context: TenantContext,
): Promise<ShortlistParticipation> => {
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
    .filter((shortlist) =>
      participantsInclude(
        participantsOf(shortlist.participantInformation),
        registrationNumber,
      ),
    )
    .map((shortlist) => ({ attachmentId: shortlist.attachmentId }));

  return {
    registrationNumber,
    shortlistsChecked: shortlists.length,
    appearsOn,
  };
};
