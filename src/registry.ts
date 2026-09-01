// Adding a tool: create src/tools/<id>/ (module + scoped css) and add one line here.
import type { Tool } from "./shell/types";
import base64ToImage from "./tools/base64-to-image";
import dnsLookup from "./tools/dns-lookup";
import imageMetadata from "./tools/image-metadata";
import jsoncSorter from "./tools/jsonc-sorter";
import qrGenerator from "./tools/qr-generator";
import saveDecoder from "./tools/save-decoder";

export const tools: Tool[] = [base64ToImage, dnsLookup, imageMetadata, jsoncSorter, qrGenerator, saveDecoder];
