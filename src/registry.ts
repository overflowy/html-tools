// Adding a tool: create src/tools/<id>/ (module + scoped css) and add one line here.
import type { Tool } from "./shell/types";
import base64ToImage from "./tools/base64-to-image";
import jsoncSorter from "./tools/jsonc-sorter";
import saveDecoder from "./tools/save-decoder";

export const tools: Tool[] = [base64ToImage, jsoncSorter, saveDecoder];
