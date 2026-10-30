// What the player sees and hears: the eight Colors, the Shape Sets, and the letters.

import { itemAt } from "./engine";
import type { Op } from "./engine";
import { SOUNDS } from "./sounds";

/** The Color Modality's eight, picked to stay apart on the Theme's dark board. */
export const COLORS = [
  { hex: "#3f7cf5", name: "blue" },
  { hex: "#35cfe0", name: "cyan" },
  { hex: "#4cc552", name: "green" },
  { hex: "#8d8d87", name: "grey" },
  { hex: "#d957d0", name: "magenta" },
  { hex: "#e4473d", name: "red" },
  { hex: "#f2f1eb", name: "white" },
  { hex: "#f0cd3a", name: "yellow" },
] as const;

/** Multi-stimulus objects told apart by Color: blue, green, yellow, red, in object order. */
export const IDENTITY_COLORS = [0, 2, 7, 5];
/** Multi-stimulus objects told apart by Shape (when their Color is the Modality): square, triangle, star, diamond. */
export const IDENTITY_SHAPES = [5, 7, 6, 0];

export type ShapeSetId = "shapes" | "pentominoes";

const polygon = (
  sides: number,
  r: number,
  startDeg: number,
  dy = 0
): string => {
  const pts: string[] = [];
  for (let i = 0; i < sides; i += 1) {
    const a = ((startDeg + (360 / sides) * i) * Math.PI) / 180;
    pts.push(
      `${(50 + r * Math.cos(a)).toFixed(1)} ${(
        50 +
        dy +
        r * Math.sin(a)
      ).toFixed(1)}`
    );
  }
  return `M${pts.join(" L")} Z`;
};

const star = (points: number, outer: number, inner: number, dy = 0): string => {
  const pts: string[] = [];
  for (let i = 0; i < points * 2; i += 1) {
    const r = i % 2 ? inner : outer;
    const a = ((-90 + (180 / points) * i) * Math.PI) / 180;
    pts.push(
      `${(50 + r * Math.cos(a)).toFixed(1)} ${(
        50 +
        dy +
        r * Math.sin(a)
      ).toFixed(1)}`
    );
  }
  return `M${pts.join(" L")} Z`;
};

/** Path data in a 100×100 box, each filled whole. */
const SHAPES: { name: string; d: string }[] = [
  { d: "M50 6 L92 50 L50 94 L8 50 Z", name: "diamond" },
  { d: "M8 66 A42 42 0 0 1 92 66 Z", name: "half circle" },
  { d: polygon(6, 44, -90), name: "hexagon" },
  { d: polygon(8, 44, -67.5), name: "octagon" },
  { d: polygon(5, 46, -90, 4), name: "pentagon" },
  { d: "M14 14 H86 V86 H14 Z", name: "square" },
  { d: star(5, 46, 19, 4), name: "star" },
  { d: "M50 8 L94 86 L6 86 Z", name: "triangle" },
];

/** The eight pentominoes with a letter name that fit in three by three: F, P, T, U, V, W, X, Z. */
const PENTOMINOES: [string, string][] = [
  ["F", ".##/##./.#."],
  ["P", "##/##/#."],
  ["T", "###/.#./.#."],
  ["U", "#.#/###"],
  ["V", "#../#../###"],
  ["W", "#../##./.##"],
  ["X", ".#./###/.#."],
  ["Z", "##./.#./.##"],
];

/** One path of unit squares, centred, with neighbours overlapping a hair so no seam shows between them. */
const cells = (pattern: string): string => {
  const rows = pattern.split("/");
  const size = 28;
  const h = rows.length * size;
  const w = Math.max(...rows.map((r) => r.length)) * size;
  const x0 = (100 - w) / 2;
  const y0 = (100 - h) / 2;
  let d = "";
  for (const [y, row] of rows.entries()) {
    for (const [x, c] of [...row].entries()) {
      if (c !== "#") {
        continue;
      }
      const left = x0 + x * size - 0.3;
      const top = y0 + y * size - 0.3;
      d += `M${left.toFixed(1)} ${top.toFixed(1)}h${size + 0.6}v${size + 0.6}h-${size + 0.6}Z`;
    }
  }
  return d;
};

export const SHAPE_SETS: Record<ShapeSetId, { name: string; d: string }[]> = {
  pentominoes: PENTOMINOES.map(([name, p]) => ({
    d: cells(p),
    name: `${name} pentomino`,
  })),
  shapes: SHAPES,
};

export const shapeSvg = (
  set: ShapeSetId,
  index: number,
  fill: string
): string => {
  const s = itemAt(SHAPE_SETS[set], index);
  return `<svg viewBox="0 0 100 100" aria-hidden="true"><path d="${s.d}" fill="${fill}"/></svg>`;
};

/* ---------------- Sounds ---------------- */

export interface SoundItem {
  /** What the player sees for it: Combination's letter in the grid. */
  label: string;
  /** The recording, as a data: URL. */
  url: string;
}

/** The Sound Modality's eight letters, consonants no two of which rhyme, each shown by its file's name. */
export const LETTERS: SoundItem[] = Object.entries(SOUNDS.letters).map(
  ([file, url]) => ({ label: file.toUpperCase(), url })
);

/** The spoken operations of Arithmetic. */
export const OPERATIONS: Record<Op, string> = SOUNDS.operations;

/** A Session's letters, in a fresh order: which index stands for which letter changes per Session. */
export const sample = (rand: () => number): SoundItem[] => {
  const items = [...LETTERS];
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [itemAt(items, j), itemAt(items, i)];
  }
  return items;
};
