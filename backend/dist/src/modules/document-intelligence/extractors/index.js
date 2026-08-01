// Public surface of the extraction layer. Two extractors split by business
// responsibility (event knowledge vs participant knowledge) rather than by
// document type, avoiding a class-per-type explosion. Each reads a parsed
// document plus its classification and returns only its own slice; neither
// modifies events, matches events, or persists anything.
export { EventExtractor, eventExtractor, } from "./event-extractor.service.js";
export { ParticipantExtractor, participantExtractor, } from "./participant-extractor.service.js";
//# sourceMappingURL=index.js.map