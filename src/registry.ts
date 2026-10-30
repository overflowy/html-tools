// Adding a tool: create src/tools/<id>/ (module + scoped css) and add one line here.
import type { Tool } from "./shell/types";
import archiveManager from "./tools/archive-manager";
import base64ToImage from "./tools/base64-to-image";
import bigText from "./tools/big-text";
import dependencyAudit from "./tools/dependency-audit";
import dnsLookup from "./tools/dns-lookup";
import docToMarkdown from "./tools/doc-to-markdown";
import dualNBack from "./tools/dual-n-back";
import fileHashes from "./tools/file-hashes";
import imageMetadata from "./tools/image-metadata";
import jsoncSorter from "./tools/jsonc-sorter";
import markdownEditor from "./tools/markdown-editor";
import pdfToolkit from "./tools/pdf-toolkit";
import pythonIde from "./tools/python-ide";
import qrGenerator from "./tools/qr-generator";
import saveDecoder from "./tools/save-decoder";
import speechToText from "./tools/speech-to-text";
import uuidGenerator from "./tools/uuid-generator";
import whoami from "./tools/whoami";

export const tools: Tool[] = [
  archiveManager,
  base64ToImage,
  bigText,
  dependencyAudit,
  dnsLookup,
  docToMarkdown,
  dualNBack,
  fileHashes,
  imageMetadata,
  jsoncSorter,
  markdownEditor,
  pdfToolkit,
  pythonIde,
  qrGenerator,
  saveDecoder,
  speechToText,
  uuidGenerator,
  whoami,
];
