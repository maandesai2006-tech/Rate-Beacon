// PDF text extraction. Manager's reports arrive as PDFs, and the parser works
// on text, so this pulls the text layer out. Scanned/image-only PDFs have no
// text layer and are reported as such rather than silently yielding nothing.

export interface PdfText {
  text: string;
  pages: number;
  hasTextLayer: boolean;
}

export async function pdfToText(data: Uint8Array): Promise<PdfText> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const doc = await getDocumentProxy(data);
  const { text, totalPages } = await extractText(doc, { mergePages: false });
  const pages = Array.isArray(text) ? text : [String(text)];
  // Keep page breaks as blank lines; the metric parser is line-oriented.
  const joined = pages.join("\n\n");
  return {
    text: joined,
    pages: totalPages ?? pages.length,
    hasTextLayer: joined.replace(/\s/g, "").length > 40,
  };
}
