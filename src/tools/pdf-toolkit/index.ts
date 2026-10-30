import "./tool.css";
import type { Tool } from "../../shell/types";
import { Toolkit } from "./ui/toolkit";

const tool: Tool = {
  id: "pdf-toolkit",
  keywords: [
    "pdf",
    "merge",
    "split",
    "rotate",
    "reorder",
    "compress",
    "watermark",
    "stamp",
    "page numbers",
    "bates",
    "n-up",
    "booklet",
    "poster",
    "crop",
    "redact",
    "encrypt",
    "password",
    "sanitize",
    "form",
    "annotate",
    "signature",
    "ocr",
    "bookmarks",
    "attachments",
    "metadata",
    "images to pdf",
    "compare",
    "linearize",
  ],
  mount: (root, ctx) => {
    Toolkit.mount(root, ctx);
  },
  name: "PDF Toolkit",
  subtitle:
    "Merge, organize, lay out, stamp, fill, annotate, redact, secure, inspect, compare, and OCR PDFs, with a live preview of every change.",
};

export default tool;
