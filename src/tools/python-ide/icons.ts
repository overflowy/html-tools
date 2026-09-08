// Icons on the Shell's 16px grid, 1.5px strokes, round caps, like the Sidebar's.

const SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

export const ICON_RUN = SVG + '<path d="M4.5 2.5v11l9-5.5z" fill="currentColor" stroke="none"/></svg>';
export const ICON_STOP = SVG + '<rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" stroke="none"/></svg>';
export const ICON_RESTART = SVG + '<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5v3h-3"/></svg>';
export const ICON_FORMAT = SVG + '<path d="M6.5 2.5l1.2 3.3 3.3 1.2-3.3 1.2-1.2 3.3-1.2-3.3L2 7l3.3-1.2z"/><path d="M12 9.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/></svg>';
/** A cog, drawn on a 24px grid at the same visual stroke weight as the rest. */
export const ICON_SETTINGS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>';
export const ICON_STDIN = SVG + '<path d="M2.5 4h11M2.5 8h7M2.5 12h4"/><path d="M11 10.5l2.5 1.5-2.5 1.5z" fill="currentColor" stroke="none"/></svg>';
export const ICON_NEW_FILE = SVG + '<path d="M9 1.5H4a.5.5 0 0 0-.5.5v12a.5.5 0 0 0 .5.5h8a.5.5 0 0 0 .5-.5V5z"/><path d="M9 1.5V5h3.5M8 7.5v4M6 9.5h4"/></svg>';
export const ICON_NEW_FOLDER = SVG + '<path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h6.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/><path d="M8 7.5v4M6 9.5h4"/></svg>';
export const ICON_UPLOAD = SVG + '<path d="M8 11V3.5M5 6.5l3-3 3 3"/><path d="M2.5 11.5v1a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1"/></svg>';
export const ICON_FOLDER = SVG + '<path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h6.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/></svg>';
export const ICON_FOLDER_OPEN = SVG + '<path d="M1.5 13.5V4.5a1 1 0 0 1 1-1h3l1.5 1.5h6.5a1 1 0 0 1 1 1V7"/><path d="M1.5 13.5l1.7-5.2a1 1 0 0 1 .95-.7H14.5l-1.8 5.2a1 1 0 0 1-.95.7z"/></svg>';
export const ICON_FILE = SVG + '<path d="M9 1.5H4a.5.5 0 0 0-.5.5v12a.5.5 0 0 0 .5.5h8a.5.5 0 0 0 .5-.5V5z"/><path d="M9 1.5V5h3.5"/></svg>';
export const ICON_PYTHON = SVG + '<path d="M8 1.5c-2.2 0-3.5.8-3.5 2.2V6h3.7v.6H3.3c-1.2 0-1.8 1-1.8 2.4 0 1.5.6 2.4 1.8 2.4h1.2V9.6c0-1.2 1-2.1 2.2-2.1h3.4c1 0 1.9-.8 1.9-1.8V3.7c0-1.4-1.6-2.2-4-2.2z"/><path d="M8 14.5c2.2 0 3.5-.8 3.5-2.2V10H7.8v-.6h4.9c1.2 0 1.8-1 1.8-2.4 0-1.5-.6-2.4-1.8-2.4h-1.2v1.8c0 1.2-1 2.1-2.2 2.1H5.9c-1 0-1.9.8-1.9 1.8v2c0 1.4 1.6 2.2 4 2.2z"/></svg>';
export const ICON_CLOSE = SVG + '<path d="M4 4l8 8M12 4l-8 8"/></svg>';
export const ICON_CHEVRON = SVG + '<path d="M6 3.5l4.5 4.5L6 12.5"/></svg>';
export const ICON_MORE = SVG + '<circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none"/></svg>';
export const ICON_DOWNLOAD = SVG + '<path d="M8 3v8M5 8l3 3 3-3"/><path d="M2.5 11.5v1a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1"/></svg>';
export const ICON_TRASH = SVG + '<path d="M3 4.5h10M6.5 4.5v-1a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M4.5 4.5l.6 8.1a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.1"/></svg>';
export const ICON_FIGURE = SVG + '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M4.5 10.5l2.5-3 2 2 2.5-3.5"/></svg>';
/** The Shell's panel icon turned on its side: a frame with the bottom part split off. */
export const ICON_PANEL = SVG + '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="M1.75 9.5h12.5"/></svg>';
/** A tilted eraser: clear the Terminal. */
export const ICON_CLEAR = SVG + '<path d="M2.5 10.5l6-6a1.4 1.4 0 0 1 2 0l3 3a1.4 1.4 0 0 1 0 2l-3.5 3.5H6.5l-4-4z"/><path d="M6.5 13H14M6 6.5l4 4"/></svg>';
export const ICON_COPY = SVG + '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg>';
export const ICON_CHECK = SVG + '<path d="M3 8.5l3.2 3.2L13 5"/></svg>';
/** The Shell's own Sidebar glyph. */
export const ICON_SIDEBAR = SVG + '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="M6 2.75v10.5"/></svg>';
export const ICON_SEARCH = SVG + '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3 3"/></svg>';
