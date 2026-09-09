/** Source of the Document to Markdown worker bundle, injected by build.ts. */
declare const DOC_WORKER_SRC: string;
/** Source of the Python IDE's interpreter worker bundle, injected by build.ts. */
declare const PYIDE_PY_WORKER_SRC: string;
/** Source of the Python IDE's Ruff worker bundle, injected by build.ts. */
declare const PYIDE_RUFF_WORKER_SRC: string;
/** Python sources are imported as text (build.ts loader). */
declare module "*.py" {
  const source: string;
  export default source;
}
/** Lucide icons are imported one SVG file at a time, as the inline markup (build.ts plugin). */
declare module "lucide-static/icons/*.svg" {
  const markup: string;
  export default markup;
}
/** Symbols file and folder icons, one component each, rendered to markup at build time (build.ts plugin). */
declare module "@react-symbols/icons/files/*" {
  const markup: string;
  export default markup;
}
declare module "@react-symbols/icons/folders/*" {
  const markup: string;
  export default markup;
}
