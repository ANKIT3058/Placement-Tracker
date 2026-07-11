// Base marker interface for parser-produced metadata. Each parser defines its
// own concrete shape by extending this, so metadata is strongly typed per format
// instead of an opaque `Record<string, unknown>`. Downstream code can narrow to
// a concrete type (e.g. PdfMetadata) when it knows which parser ran.
export interface ParsedMetadata {}

// Metadata produced by the PDF parser. Both fields are optional because pdf-parse
// only reports what pdf.js can read from a given document.
export interface PdfMetadata extends ParsedMetadata {
  pages?: number;
  pdfVersion?: string;
}
