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
