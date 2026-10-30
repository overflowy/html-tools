// Lookups into markup the Python IDE wrote itself: a missing element there is
// a bug, so it throws rather than handing back null.

/** The first element under `root` matching `selector`. */
export const required = <E extends Element = HTMLElement>(
  root: ParentNode,
  selector: string
): E => {
  const el = root.querySelector<E>(selector);
  if (!el) {
    throw new Error(`The Python IDE's markup has no ${selector}.`);
  }
  return el;
};
