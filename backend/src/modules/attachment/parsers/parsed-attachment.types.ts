// The normalized output every AttachmentParser returns. Kept intentionally
// small and format-agnostic: `text` is the flattened textual content every
// parser can produce, while `structuredData` and `metadata` are optional escape
// hatches for richer, format-specific results (e.g. Excel rows, PDF page count)
// so future parsers can enrich this without changing the shared contract.
export interface ParsedAttachment {
  text: string;

  structuredData?: unknown;

  metadata?: Record<string, unknown>;
}
