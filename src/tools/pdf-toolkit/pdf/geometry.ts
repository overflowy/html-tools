// Points, rectangles, and matrices the way PDF and MuPDF have them: a
// matrix [a b c d e f] maps a row vector, p' = p × M, so concat(A, B)
// applies A first and B second. Two spaces matter everywhere in this Tool:
// a page's user space, which its content stream draws in (y up, origin
// wherever the page's boxes say), and its display space, MuPDF's "fz"
// space, which is what the user sees (y down, origin at the top left of the
// crop box, the page's /Rotate applied). A page's transform maps the first
// to the second. Everything the user places, they place in display space.

export type Matrix = [number, number, number, number, number, number];
export type Rect = [number, number, number, number];
export type Point = [number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export const concat = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];

/** Every matrix in order: the first applied first. */
export const chain = (...ms: Matrix[]): Matrix => {
  let acc = IDENTITY;
  for (const m of ms) {
    acc = concat(acc, m);
  }
  return acc;
};

export const scale = (sx: number, sy = sx): Matrix => [sx, 0, 0, sy, 0, 0];

export const translate = (tx: number, ty: number): Matrix => [
  1,
  0,
  0,
  1,
  tx,
  ty,
];

/** Rotation by `deg` degrees; in display space (y down) a positive angle turns clockwise. */
const RIGHT_ANGLES = new Map<number, [cos: number, sin: number]>([
  [0, [1, 0]],
  [90, [0, 1]],
  [180, [-1, 0]],
  [270, [0, -1]],
]);

export const rotate = (deg: number): Matrix => {
  // Exact for right angles, so a quarter turn leaves no 6e-17 behind.
  const exact = Number.isInteger(deg)
    ? RIGHT_ANGLES.get(((deg % 360) + 360) % 360)
    : undefined;
  if (exact) {
    const [c, s] = exact;
    return [c, s, -s, c, 0, 0];
  }
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
};

export const invert = (m: Matrix): Matrix => {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) {
    return IDENTITY;
  }
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -m[4] * a - m[5] * c, -m[4] * b - m[5] * d];
};

export const apply = (m: Matrix, [x, y]: Point): Point => [
  x * m[0] + y * m[2] + m[4],
  x * m[1] + y * m[3] + m[5],
];

/** The smallest rectangle holding all four transformed corners. */
export const transformRect = (m: Matrix, r: Rect): Rect => {
  const pts = [
    apply(m, [r[0], r[1]]),
    apply(m, [r[2], r[1]]),
    apply(m, [r[0], r[3]]),
    apply(m, [r[2], r[3]]),
  ];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

export const normalize = (r: Rect): Rect => [
  Math.min(r[0], r[2]),
  Math.min(r[1], r[3]),
  Math.max(r[0], r[2]),
  Math.max(r[1], r[3]),
];

export const width = (r: Rect) => r[2] - r[0];
export const height = (r: Rect) => r[3] - r[1];

export const intersect = (a: Rect, b: Rect): Rect | null => {
  const r: Rect = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
  return r[2] > r[0] && r[3] > r[1] ? r : null;
};

/** A number for a content stream: at most four decimals, no exponent, no trailing zeros. */
export const num = (n: number): string => {
  if (!Number.isFinite(n)) {
    return "0";
  }
  const s = n.toFixed(4).replace(/\.?0+$/u, "");
  return s === "-0" ? "0" : s;
};

export const fmtMatrix = (m: Matrix): string => m.map(num).join(" ");

/**
 * The matrix that fits a `w`×`h` box into `target` (both in one space),
 * scaled uniformly and centered, or stretched to fill when `uniform` is false.
 */
export const fitInto = (
  w: number,
  h: number,
  target: Rect,
  uniform = true
): Matrix => {
  const tw = width(target);
  const th = height(target);
  if (!uniform) {
    return chain(scale(tw / w, th / h), translate(target[0], target[1]));
  }
  const s = Math.min(tw / w, th / h);
  return chain(
    scale(s),
    translate(target[0] + (tw - w * s) / 2, target[1] + (th - h * s) / 2)
  );
};

/* ---------------- paper ---------------- */

export const POINTS_PER_INCH = 72;
export const POINTS_PER_MM = 72 / 25.4;

/** Portrait sizes in points. */
export const PAPER = {
  a3: [841.89, 1190.55],
  a4: [595.28, 841.89],
  a5: [419.53, 595.28],
  legal: [612, 1008],
  letter: [612, 792],
  tabloid: [792, 1224],
} as const satisfies Record<string, readonly [number, number]>;

export type PaperId = keyof typeof PAPER;

export const PAPER_NAMES: Record<PaperId, string> = {
  a3: "A3",
  a4: "A4",
  a5: "A5",
  legal: "Legal",
  letter: "Letter",
  tabloid: "Tabloid",
};

export const isPaper = (s: string): s is PaperId => Object.hasOwn(PAPER, s);

/** A paper in the asked orientation: "portrait", "landscape", or the one matching `w`×`h` ("auto"). */
export const paperSize = (
  id: PaperId,
  orientation: "portrait" | "landscape" | "auto",
  w = 1,
  h = 1.4
): [number, number] => {
  const [pw, ph] = PAPER[id];
  const landscape =
    orientation === "landscape" || (orientation === "auto" && w > h);
  return landscape ? [ph, pw] : [pw, ph];
};

/** How a size in points reads: millimetres and inches, and the paper it is, if any. */
export const describeSize = (w: number, h: number): string => {
  const near = (a: number, b: number) => Math.abs(a - b) < 2;
  for (const [id, [pw, ph]] of Object.entries(PAPER)) {
    if ((near(w, pw) && near(h, ph)) || (near(w, ph) && near(h, pw))) {
      return `${PAPER_NAMES[id as PaperId]}${w > h ? " landscape" : ""}`;
    }
  }
  const mm = (n: number) => Math.round(n / POINTS_PER_MM);
  return `${mm(w)} × ${mm(h)} mm`;
};
