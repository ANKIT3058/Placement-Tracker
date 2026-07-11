import type { ParsedMetadata } from "./types/parser-metadata.interface.js";

// The normalized output every AttachmentParser returns. Kept intentionally
// small and format-agnostic: `text` is the flattened textual content every
// parser can produce, while `structuredData` and `metadata` are optional escape
// hatches for richer, format-specific results (e.g. Excel rows, PDF page count).
// `metadata` is strongly typed via ParsedMetadata so each parser can expose a
// concrete shape (e.g. PdfMetadata) rather than an opaque map.
export interface ParsedAttachment {
  text: string;

  structuredData?: unknown;

  metadata?: ParsedMetadata;
}
