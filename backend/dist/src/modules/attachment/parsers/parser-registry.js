import { PdfParser } from "./pdf.parser.js";
import { SpreadsheetParser } from "./spreadsheet.parser.js";
// Central lookup that maps a document's MIME type to a parser. This is the ONLY
// place in the module that knows which parser handles which format, keeping the
// worker and DocumentProcessingService free of MIME-type conditionals.
export class ParserRegistry {
    parsers;
    constructor(parsers) {
        this.parsers = parsers;
    }
    // First registered parser that supports the MIME type, or undefined when the
    // format is not handled. Callers treat undefined as "nothing to parse".
    findParser(mimeType) {
        return this.parsers.find((parser) => parser.supports(mimeType));
    }
}
// Shared registry wired with the currently-known parsers. Supporting a new
// format is a one-line addition here (plus the parser file) — no other module
// changes.
export const parserRegistry = new ParserRegistry([
    new PdfParser(),
    new SpreadsheetParser(),
]);
//# sourceMappingURL=parser-registry.js.map