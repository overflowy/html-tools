// Small DOM and formatting helpers the PDF Toolkit's panels share.

export const formatBytes = (n: number): string => {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

export const count = (n: number, one: string, many: string): string =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

export const message = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

interface Props {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string>;
}

/** An element with a class, text, attributes, and children. */
export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (props.class) {
    node.className = props.class;
  }
  if (props.text !== undefined) {
    node.textContent = props.text;
  }
  if (props.title) {
    node.title = props.title;
  }
  for (const [k, v] of Object.entries(props.attrs ?? {})) {
    node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
};

export const button = (
  label: string,
  onClick: () => void,
  props: Props & { primary?: boolean } = {}
): HTMLButtonElement => {
  const b = el("button", {
    ...props,
    class: [props.primary ? "primary" : "", props.class ?? ""].join(" ").trim(),
    text: label,
  });
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
};

/** An icon button: the icon's markup, and its name for those who cannot see it. */
export const iconButton = (
  svg: string,
  label: string,
  onClick: () => void,
  cls = ""
): HTMLButtonElement => {
  const b = el("button", {
    attrs: { "aria-label": label },
    class: `icon ${cls}`.trim(),
    title: label,
  });
  b.type = "button";
  b.innerHTML = svg;
  b.addEventListener("click", onClick);
  return b;
};

/** Save `blob` as a download named `name`. */
export const download = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const a = el("a", { attrs: { download: name, href: url } });
  document.body.append(a);
  a.click();
  a.remove();
  // Firefox starts the download after the click returns; give it a moment.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

export const pdfBlob = (bytes: Uint8Array): Blob =>
  new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" });

/** A file name's stem: "report.final.pdf" is "report.final". */
export const stem = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

export const extension = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

/**
 * Wait for `p` and ignore its failure: for tidying up (closing a document,
 * stopping a recognizer) that may fail harmlessly because what it tidies is
 * already gone.
 */
export const quietly = async (
  p: Promise<unknown> | undefined
): Promise<void> => {
  try {
    await p;
  } catch {
    // Already gone.
  }
};

/** `fn`, run once calls stop coming for `ms`. */
export const debounce = <A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number
) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const call = (...args: A) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  call.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return call;
};

/** A definition list of label and value rows. */
export const facts = (rows: [string, string | Node][]): HTMLDListElement => {
  const dl = el("dl", { class: "facts" });
  for (const [k, v] of rows) {
    dl.append(el("dt", { text: k }), el("dd", {}, v));
  }
  return dl;
};

export const formatDate = (iso: string | null): string => {
  if (!iso) {
    return "";
  }
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};
