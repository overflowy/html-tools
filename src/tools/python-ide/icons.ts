// The IDE's icons: Lucide, one SVG file per icon (build.ts turns each into
// its inline markup at the Collection's stroke). Named for what they mean
// here, so a call site reads as the action and the glyph can change alone.
// The Tree's file and folder icons are another set: see file-icons.ts.

import check from "lucide-static/icons/check.svg";
import chevronRight from "lucide-static/icons/chevron-right.svg";
import copy from "lucide-static/icons/copy.svg";
import download from "lucide-static/icons/download.svg";
import ellipsis from "lucide-static/icons/ellipsis.svg";
import eraser from "lucide-static/icons/eraser.svg";
import filePlus from "lucide-static/icons/file-plus.svg";
import folderPlus from "lucide-static/icons/folder-plus.svg";
import image from "lucide-static/icons/image.svg";
import panelBottom from "lucide-static/icons/panel-bottom.svg";
import panelLeft from "lucide-static/icons/panel-left.svg";
import play from "lucide-static/icons/play.svg";
import rotateCw from "lucide-static/icons/rotate-cw.svg";
import search from "lucide-static/icons/search.svg";
import settings from "lucide-static/icons/settings.svg";
import sparkles from "lucide-static/icons/sparkles.svg";
import square from "lucide-static/icons/square.svg";
import textCursorInput from "lucide-static/icons/text-cursor-input.svg";
import trash from "lucide-static/icons/trash.svg";
import upload from "lucide-static/icons/upload.svg";
import x from "lucide-static/icons/x.svg";
import variable from "lucide-static/icons/variable.svg";

/** Filled by the run bar's CSS, as playback controls are. */
export const ICON_RUN = play;
export const ICON_STOP = square;
export const ICON_RESTART = rotateCw;
export const ICON_FORMAT = sparkles;
export const ICON_SETTINGS = settings;
export const ICON_STDIN = textCursorInput;
export const ICON_NEW_FILE = filePlus;
export const ICON_TYPE_HINTS = variable;
export const ICON_NEW_FOLDER = folderPlus;
export const ICON_UPLOAD = upload;
export const ICON_CLOSE = x;
export const ICON_CHEVRON = chevronRight;
export const ICON_MORE = ellipsis;
export const ICON_DOWNLOAD = download;
export const ICON_TRASH = trash;
export const ICON_FIGURE = image;
export const ICON_PANEL = panelBottom;
export const ICON_CLEAR = eraser;
export const ICON_COPY = copy;
export const ICON_CHECK = check;
/** The Shell's own Sidebar glyph. */
export const ICON_SIDEBAR = panelLeft;
export const ICON_SEARCH = search;
