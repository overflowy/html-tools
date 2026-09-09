// The Tree's icons: Symbols, the VS Code icon theme, one component imported
// per icon (build.ts renders each to its markup). Which icon a file gets
// follows the theme's own mapping for every kind of file the Tool knows,
// with one liberty: stubs and Cython sources are Python too.

import bracketsPurple from "@react-symbols/icons/files/BracketsPurple";
import bracketsYellow from "@react-symbols/icons/files/BracketsYellow";
import codeOrange from "@react-symbols/icons/files/CodeOrange";
import compressed from "@react-symbols/icons/files/Compressed";
import csv from "@react-symbols/icons/files/Csv";
import database from "@react-symbols/icons/files/Database";
import docker from "@react-symbols/icons/files/Docker";
import document from "@react-symbols/icons/files/Document";
import editorConfig from "@react-symbols/icons/files/EditorConfig";
import gear from "@react-symbols/icons/files/Gear";
import git from "@react-symbols/icons/files/Git";
import image from "@react-symbols/icons/files/Image";
import js from "@react-symbols/icons/files/Js";
import license from "@react-symbols/icons/files/License";
import lock from "@react-symbols/icons/files/Lock";
import markdown from "@react-symbols/icons/files/Markdown";
import notebook from "@react-symbols/icons/files/Notebook";
import pdf from "@react-symbols/icons/files/PDF";
import python from "@react-symbols/icons/files/Python";
import shell from "@react-symbols/icons/files/Shell";
import svg from "@react-symbols/icons/files/SVG";
import text from "@react-symbols/icons/files/Text";
import typescript from "@react-symbols/icons/files/TypeScript";
import xml from "@react-symbols/icons/files/XML";
import yaml from "@react-symbols/icons/files/Yaml";
import audio from "@react-symbols/icons/files/Audio";
import video from "@react-symbols/icons/files/Video";
import folder from "@react-symbols/icons/folders/Folder";
import folderOpen from "@react-symbols/icons/folders/FolderOpen";
import { basename } from "./project";

export const ICON_FOLDER = folder;
export const ICON_FOLDER_OPEN = folderOpen;

const BY_NAME: Record<string, string> = {
  LICENSE: license,
  README: markdown,
  Dockerfile: docker,
  ".gitignore": git,
  ".editorconfig": editorConfig,
  "requirements.txt": python,
};

const BY_EXTENSION: Record<string, string> = {
  py: python, pyi: python, pyx: python,
  toml: gear, env: gear,
  md: markdown, markdown: markdown,
  txt: text,
  json: bracketsYellow,
  csv: csv, tsv: csv,
  yaml: yaml, yml: yaml,
  html: codeOrange, htm: codeOrange,
  css: bracketsPurple,
  js: js,
  ts: typescript,
  xml: xml,
  svg: svg,
  sh: shell,
  sql: database,
  lock: lock,
  ipynb: notebook,
  pdf: pdf,
  zip: compressed, gz: compressed, tar: compressed,
  png: image, jpg: image, jpeg: image, gif: image, webp: image, bmp: image, ico: image,
  wav: audio, mp3: audio, ogg: audio, flac: audio,
  mp4: video, webm: video, mov: video,
};

/** The icon for a file, by its name first and its extension second; a plain document otherwise. */
export function fileIcon(path: string): string {
  const name = basename(path);
  const byName = BY_NAME[name];
  if (byName) return byName;
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? BY_EXTENSION[name.slice(dot + 1).toLowerCase()] : undefined) ?? document;
}
