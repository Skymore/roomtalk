/*
Adapted from CopilotKit/OpenMuse packages/integrations/src/pdf.ts at 73a714963b57e5cd1747fd3fbc6833e09a36b81a.
MIT License

Copyright (c) 2026 OpenMuse contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import {
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  type PDFField,
  PDFHexString,
  PDFName,
  type PDFObject,
  PDFOptionList,
  PDFRadioGroup,
  PDFString,
  PDFTextField,
  StandardFonts,
} from "pdf-lib";

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_PDF_PAGES = 500;

export class PdfError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = "PdfError";
  }
}

async function pdfOperation<T>(operation: () => Promise<T>, fallback: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PdfError) throw error;
    throw new PdfError(fallback);
  }
}

export interface PdfInspection {
  pageCount: number;
  fields: { name: string; value: string; type: "text" | "checkbox" | "unsupported" }[];
}

async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  if (
    !bytes.length ||
    bytes.length > MAX_PDF_BYTES ||
    Buffer.from(bytes.subarray(0, 1024)).indexOf("%PDF-") < 0
  ) {
    throw new PdfError("Invalid PDF: expected nonempty PDF bytes up to 10 MiB");
  }
  try {
    const doc = await PDFDocument.load(new Uint8Array(bytes), {
      ignoreEncryption: false,
      throwOnInvalidObject: true,
      updateMetadata: false,
    });
    if (doc.isEncrypted) throw new PdfError("Encrypted PDFs are not supported");
    if (doc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict)?.has(PDFName.of("XFA"))) {
      throw new PdfError("Unsupported XFA PDF form");
    }
    if (doc.getPageCount() < 1 || doc.getPageCount() > MAX_PDF_PAGES)
      throw new PdfError("PDF must contain between 1 and 500 pages");
    return doc;
  } catch (error) {
    if (error instanceof PdfError) throw error;
    if (error instanceof Error && /encrypt/i.test(error.message))
      throw new PdfError("Encrypted PDFs are not supported");
    throw new PdfError("Invalid or malformed PDF");
  }
}

function inspectField(field: PDFField): PdfInspection["fields"][number] {
  const name = field.getName();
  if (field instanceof PDFTextField) {
    const value = field.acroField.dict.lookup(PDFName.of("V"));
    if (value !== undefined && !(value instanceof PDFString) && !(value instanceof PDFHexString)) {
      throw new PdfError("Cannot inspect PDF: a text field contains a malformed value");
    }
    return { name, value: field.getText() ?? "", type: "text" };
  }
  if (field instanceof PDFCheckBox)
    return { name, value: String(field.isChecked()), type: "checkbox" };
  const value =
    field instanceof PDFDropdown || field instanceof PDFOptionList
      ? field.getSelected().join(", ")
      : field instanceof PDFRadioGroup
        ? (field.getSelected() ?? "")
        : "";
  return { name, value, type: "unsupported" };
}

export async function inspectPdf(bytes: Uint8Array): Promise<PdfInspection> {
  return pdfOperation(async () => {
    const doc = await loadPdf(bytes);
    return { pageCount: doc.getPageCount(), fields: doc.getForm().getFields().map(inspectField) };
  }, "Cannot inspect PDF: the document contains malformed or unsupported form fields");
}

/** Strip action entry points in the new output; never execute PDF scripts. */
function removeActions(doc: PDFDocument): void {
  const visited = new Set<PDFObject>();
  const visit = (object: PDFObject): void => {
    if (visited.has(object)) return;
    visited.add(object);
    if (object instanceof PDFDict) {
      for (const key of ["OpenAction", "AA", "A", "JS", "JavaScript"])
        object.delete(PDFName.of(key));
      for (const value of object.values()) visit(value);
    } else if (object instanceof PDFArray) {
      for (const value of object.asArray()) visit(value);
    }
  };
  for (const [, object] of doc.context.enumerateIndirectObjects()) visit(object);
}

export async function fillPdf(
  bytes: Uint8Array,
  values: Record<string, string | boolean>,
): Promise<Uint8Array> {
  return pdfOperation(async () => {
    const doc = await loadPdf(bytes);
    const form = doc.getForm();
    const fields = new Map(form.getFields().map((field) => [field.getName(), field]));
    for (const [name, value] of Object.entries(values)) {
      const field = fields.get(name);
      if (!field) throw new PdfError(`Unknown PDF field: ${name}`);
      if (field instanceof PDFTextField) {
        if (typeof value !== "string")
          throw new PdfError(`PDF text field requires a string: ${name}`);
        if (value.length > 10000) throw new PdfError(`PDF text field value is too long: ${name}`);
        field.setText(value);
      } else if (field instanceof PDFCheckBox) {
        if (typeof value !== "boolean")
          throw new PdfError(`PDF checkbox requires a boolean: ${name}`);
        if (value) field.check();
        else field.uncheck();
      } else {
        throw new PdfError(`Unsupported PDF field: ${name}`);
      }
    }
    removeActions(doc);
    try {
      form.updateFieldAppearances(await doc.embedFont(StandardFonts.Helvetica));
      return await doc.save();
    } catch {
      throw new PdfError(
        "Could not render PDF field values; use characters supported by this form's font or choose a compatible PDF form",
      );
    }
  }, "Could not fill PDF: the document contains malformed or unsupported form fields");
}
