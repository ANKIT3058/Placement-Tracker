// Shared text normalization used by every parser. Extracted from PdfParser so
// all current and future parsers (Excel, DOCX, OCR) clean their text output the
// same way, producing consistent, diff-friendly plain text without each parser
// reimplementing the rules.
export class TextNormalizer {
  // Normalize raw extracted text:
  //  - convert Windows (\r\n) and old-Mac (\r) line endings to Unix (\n),
  //  - collapse repeated spaces/tabs into a single space,
  //  - remove trailing whitespace at the end of every line,
  //  - collapse 3+ blank lines into one, preserving paragraph separation.
  static normalize(raw: string): string {
    return raw
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/ +$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}
