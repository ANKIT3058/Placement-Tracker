// Structured representation of a parsed spreadsheet. This is the faithful,
// lossless-in-order counterpart to the flattened `text` field: it preserves the
// workbook's sheets, rows and cells exactly as read, with NO interpretation
// (no header detection, schema inference, cell merging or name detection).
// Downstream AI consumes `text`; anything that needs the original grid shape
// (row/column positions) uses this instead.
export {};
//# sourceMappingURL=spreadsheet-data.interface.js.map