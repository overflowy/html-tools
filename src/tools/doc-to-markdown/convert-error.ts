// A refusal or failure reported by the conversion worker, with the details
// the converter gives: a code, and for a PDF that needs OCR, which pages.

import type { WorkerResponse } from "./worker";

export class ConvertError extends Error {
  code?: string;
  pages?: number[];
  pageCount?: number;
  constructor(r: Extract<WorkerResponse, { type: "error" }>) {
    super(r.message);
    this.name = "ConvertError";
    this.code = r.code;
    this.pages = r.pages;
    this.pageCount = r.pageCount;
  }
}
