// The recorded sounds, one import per file, each a data: URL. Their sources and licenses are in NOTICE.md.

import letters_c from "./letters/c.mp3";
import letters_h from "./letters/h.mp3";
import letters_k from "./letters/k.mp3";
import letters_l from "./letters/l.mp3";
import letters_q from "./letters/q.mp3";
import letters_r from "./letters/r.mp3";
import letters_s from "./letters/s.mp3";
import letters_t from "./letters/t.mp3";
import operations_add from "./operations/add.mp3";
import operations_divide from "./operations/divide.mp3";
import operations_multiply from "./operations/multiply.mp3";
import operations_subtract from "./operations/subtract.mp3";

/** Each folder's files by name (the name without its extension). */
export const SOUNDS = {
  letters: {
    c: letters_c,
    h: letters_h,
    k: letters_k,
    l: letters_l,
    q: letters_q,
    r: letters_r,
    s: letters_s,
    t: letters_t,
  },
  operations: {
    add: operations_add,
    divide: operations_divide,
    multiply: operations_multiply,
    subtract: operations_subtract,
  },
} as const;
