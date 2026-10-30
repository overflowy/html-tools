// Panels for what a PDF gives away and who may open it: passwords and
// permissions, redaction, sanitizing, finding personal data, and digital
// signatures, checked and removed.

import { isIdentity } from "../../pdf/assemble";
import type { Rect } from "../../pdf/geometry";
import { PII_KINDS, PII_NAMES } from "../../pdf/pii";
import type { PiiFinding, PiiKind } from "../../pdf/pii";
import type { RedactMark, SanitizeReport } from "../../pdf/security";
import type { Check, SignatureReport } from "../../pdf/signatures";
import type { Quad } from "../../pdf/text";
import type { PanelDef } from "../api";
import {
  button,
  count,
  debounce,
  el,
  facts,
  formatBytes,
  formatDate,
  iconButton,
  message,
} from "../dom";
import { Form } from "../form";
import type { Field, Values } from "../form";
import { describeResult, resultFoot, transformPanel } from "../panel-kit";
import type { Gesture, Mark } from "../viewer";

const GROUP = "Security";
const row = (...children: (Node | string)[]) =>
  el("div", { class: "row" }, ...children);
const ICON_X =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

/* ---------------- protect ---------------- */

const protect = transformPanel({
  applyLabel: "",
  defaults: {
    accessibility: true,
    annotate: true,
    assemble: false,
    bits: "256",
    copy: false,
    forms: true,
    modify: false,
    ownerPassword: "",
    print: "full",
    userPassword: "",
  },
  downloadOnly: true,
  fields: [
    {
      hint: "Anyone opening the file needs it. Leave it empty for a file that opens freely but keeps its restrictions.",
      key: "userPassword",
      kind: "password",
      label: "Password to open",
    },
    {
      hint: "Needed to lift the restrictions. Left empty, a random one nobody knows is used.",
      key: "ownerPassword",
      kind: "password",
      label: "Password to change permissions",
    },
    {
      key: "bits",
      kind: "seg",
      label: "Encryption",
      options: [
        ["256", "AES-256"],
        ["128", "AES-128"],
      ],
    },
    {
      key: "print",
      kind: "seg",
      label: "Printing",
      options: [
        ["full", "Allowed"],
        ["low", "Low quality"],
        ["none", "Not allowed"],
      ],
    },
    { key: "copy", kind: "check", label: "Copying text and images" },
    { key: "modify", kind: "check", label: "Changing the document" },
    { key: "annotate", kind: "check", label: "Comments" },
    { key: "forms", kind: "check", label: "Filling in forms" },
    {
      key: "assemble",
      kind: "check",
      label: "Inserting, deleting, and turning pages",
    },
    { key: "accessibility", kind: "check", label: "Text for screen readers" },
  ],
  group: GROUP,
  id: "protect",
  intro: () =>
    el("p", {
      class: "hint",
      text: "Permissions are honoured by readers that choose to; a password to open is real encryption.",
    }),
  live: false,
  name: "Password and permissions",
  op: "protect",
  options: (v, api) => {
    if (
      !v.userPassword &&
      !v.ownerPassword &&
      v.print === "full" &&
      v.copy &&
      v.modify &&
      v.annotate &&
      v.forms &&
      v.assemble
    ) {
      return "Set a password, or take away a permission.";
    }
    return {
      accessibility: v.accessibility === true,
      annotate: v.annotate === true,
      assemble: v.assemble === true,
      bits: v.bits === "128" ? 128 : 256,
      copy: v.copy === true,
      forms: v.forms === true,
      modify: v.modify === true,
      name: `${api.name()}-protected.pdf`,
      ownerPassword: String(v.ownerPassword),
      print: v.print as "full" | "low" | "none",
      userPassword: String(v.userPassword),
    };
  },
  runLabel: "Encrypt",
  suffix: "-protected",
  summary:
    "Encrypt the PDF with a password, and choose what readers may do with it. Do this last: an encrypted file is downloaded, not worked on further here.",
});

/* ---------------- redact ---------------- */

export interface RedactHandoff {
  marks: RedactMark[];
  what: string;
}

const redact: PanelDef = {
  defaults: { black: true, images: "pixels", lineArt: true, mode: "box" },
  fields: [
    {
      key: "mode",
      kind: "seg",
      label: "Mark by",
      options: [
        ["box", "Drawing boxes"],
        ["text", "Selecting text"],
      ],
    },
    {
      key: "black",
      kind: "check",
      label: "Fill with black (else leave blank)",
    },
    {
      key: "images",
      kind: "select",
      label: "Images under a mark",
      options: [
        ["pixels", "Blank the covered part"],
        ["remove", "Remove the whole image"],
        ["none", "Leave them"],
      ],
    },
    { key: "lineArt", kind: "check", label: "Remove drawings the marks cover" },
  ],
  group: GROUP,
  id: "redact",
  mount: (api, values, handoff) => {
    const marks: RedactMark[] = [
      ...((handoff as RedactHandoff | undefined)?.marks ?? []),
    ];
    let live: { page: number; mark: Mark } | null = null;
    const list = el("ul", { class: "annots" });
    const query = el("input", {
      attrs: {
        "aria-label": "Text to redact everywhere",
        placeholder: "Text to find and mark",
        spellcheck: "false",
        type: "search",
      },
    });
    const foot = resultFoot(api, {
      applyLabel: "the redactions",
      fileName: (a) => `${a.name()}-redacted.pdf`,
    });
    const runIt = async () => {
      const r = await api.run(
        "redact",
        {
          black: values.black === true,
          images: values.images as "pixels" | "remove" | "none",
          lineArt: values.lineArt === true,
          marks,
        },
        "Redacting"
      );
      if (r?.doc) {
        api.showResult(r);
        foot.show(
          r,
          `Redacted: ${describeResult(r)}. Check the After view, then Apply or Download.`
        );
      }
    };
    const preview = button("Preview", () => {
      void runIt();
    });
    const changed = () => {
      foot.show(
        null,
        marks.length
          ? count(marks.length, "mark", "marks")
          : "Nothing marked yet."
      );
      preview.disabled = marks.length === 0;
      list.replaceChildren(
        ...marks.slice(0, 300).map((m, i) =>
          el(
            "li",
            {},
            `Page ${m.page + 1}: ${m.quads ? count(m.quads.length, "line of text", "lines of text") : "box"}`,
            iconButton(
              ICON_X,
              "Remove",
              () => {
                marks.splice(i, 1);
                changed();
              },
              "inline"
            )
          )
        )
      );
      if (marks.length > 300) {
        list.append(el("li", { text: `and ${marks.length - 300} more` }));
      }
      api.redrawMarks();
    };
    api.setMarks((page) => {
      const out: Mark[] = [];
      for (const m of marks) {
        if (m.page === page) {
          out.push(
            m.quads
              ? { kind: "quads", quads: m.quads, style: "select" }
              : { kind: "rect", rect: m.rect ?? [0, 0, 0, 0], style: "redact" }
          );
        }
      }
      if (live?.page === page) {
        out.push(live.mark);
      }
      return out;
    });
    const select = debounce(async (g: Gesture) => {
      try {
        const w = await api.worker();
        const doc = await api.current();
        const quads = (await w.call("select", [
          doc.id,
          g.page,
          g.from,
          g.to,
        ])) as Quad[];
        if (g.done) {
          live = null;
          if (quads.length) {
            marks.push({ page: g.page, quads });
            changed();
          } else {
            api.redrawMarks(g.page);
          }
        } else {
          live = {
            mark: { kind: "quads", quads, style: "select" },
            page: g.page,
          };
          api.redrawMarks(g.page);
        }
      } catch (error) {
        api.error(message(error));
      }
    }, 30);
    const setTool = () => {
      if (values.mode === "text") {
        api.setTool("text", (g) => {
          void select(g);
        });
        return;
      }
      api.setTool("rect", (g) => {
        const rect: Rect = [
          Math.min(g.from[0], g.to[0]),
          Math.min(g.from[1], g.to[1]),
          Math.max(g.from[0], g.to[0]),
          Math.max(g.from[1], g.to[1]),
        ];
        if (!g.done) {
          live = {
            mark: { kind: "rect", rect, style: "redact" },
            page: g.page,
          };
          api.redrawMarks(g.page);
          return;
        }
        live = null;
        if (rect[2] - rect[0] > 2 && rect[3] - rect[1] > 2) {
          marks.push({ page: g.page, rect });
          changed();
        } else {
          api.redrawMarks(g.page);
        }
      });
    };
    const markAll = async () => {
      const q = query.value.trim();
      if (!q) {
        return;
      }
      const r = await api.run(
        "search",
        {
          options: { caseSensitive: false, regex: false, wholeWords: false },
          query: q,
        },
        "Finding",
        { quiet: true }
      );
      const hits = r?.report.hits ?? [];
      for (const h of hits) {
        marks.push({ page: h.page, quads: h.quads });
      }
      api.note(
        hits.length
          ? `Marked ${count(hits.length, "match", "matches")} of “${q}”.`
          : `“${q}” is not in the document.`
      );
      changed();
    };
    query.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        void markAll();
      }
    });
    const form = new Form(redact.fields ?? [], values, (key) => {
      api.persist();
      if (key === "mode") {
        setTool();
      }
    });
    api.body.replaceChildren(
      el("p", { class: "summary", text: redact.summary }),
      form.root,
      row(
        query,
        button("Mark all", () => {
          void markAll();
        })
      ),
      row(
        preview,
        button("Clear marks", () => {
          marks.length = 0;
          changed();
        })
      ),
      el("h3", { text: "Marks" }),
      list,
      el("p", {
        class: "hint",
        text: "Document information (title, author) and attachments are not page content: Sanitize removes those.",
      })
    );
    if (handoff) {
      api.note(
        `${(handoff as RedactHandoff).what} marked for redaction. Check them, then Preview.`
      );
    }
    setTool();
    changed();
    return {
      destroy: () => {
        api.setTool(null);
        api.setMarks(null);
      },
      docChanged: () => {
        marks.length = 0;
        changed();
      },
    };
  },
  name: "Redact",
  summary:
    "Black out text, images, and drawings for good: what is under a mark is removed from the file, not just covered. Mark in the Pages view, preview, then apply.",
};

/* ---------------- sanitize ---------------- */

const SANITIZE_NAMES: [keyof SanitizeReport, string][] = [
  ["metadata", "Metadata"],
  ["attachments", "Attachments"],
  ["scripts", "Scripts and actions"],
  ["links", "Outside links"],
  ["thumbnails", "Thumbnails"],
  ["privateData", "Editors' private data"],
];

const sanitize = transformPanel({
  applyLabel: "sanitizing",
  defaults: {
    attachments: true,
    javascript: true,
    links: false,
    metadata: true,
    privateData: true,
    thumbnails: true,
  },
  fields: [
    {
      key: "metadata",
      kind: "check",
      label: "Metadata: title, author, dates, the program that made it",
    },
    { key: "attachments", kind: "check", label: "Attached files" },
    {
      key: "javascript",
      kind: "check",
      label: "JavaScript, and actions that launch, submit, or import",
    },
    {
      key: "links",
      kind: "check",
      label: "Links to web pages and other files",
    },
    { key: "thumbnails", kind: "check", label: "Embedded page thumbnails" },
    {
      key: "privateData",
      kind: "check",
      label: "Private data editing programs leave",
    },
  ],
  group: GROUP,
  id: "sanitize",
  live: false,
  name: "Sanitize",
  op: "sanitize",
  options: (v) => ({
    attachments: v.attachments === true,
    javascript: v.javascript === true,
    links: v.links === true,
    metadata: v.metadata === true,
    privateData: v.privateData === true,
    thumbnails: v.thumbnails === true,
  }),
  report: (r) => {
    const rows: [string, string][] = SANITIZE_NAMES.map(([k, label]) => [
      label,
      r.report[k] ? `${r.report[k]} removed` : "none found",
    ]);
    return facts(rows);
  },
  runLabel: "Sanitize",
  suffix: "-sanitized",
  summary:
    "Strip what a document carries besides its pages before sharing it. Removed objects go from the file, not just out of sight.",
});

/* ---------------- PII ---------------- */

const pii: PanelDef = {
  defaults: Object.fromEntries(PII_KINDS.map((k) => [k, true])),
  fields: PII_KINDS.map((k): Field => ({
    key: k,
    kind: "check",
    label: PII_NAMES[k],
  })),
  group: GROUP,
  id: "pii",
  mount: (api, values: Values) => {
    let found: PiiFinding[] = [];
    const list = el("div", { class: "findings" });
    const info = el("p", {
      attrs: { "aria-live": "polite" },
      class: "sel-info",
    });
    const toRedact = button("Redact all found", () => {
      api.open("redact", {
        marks: found.map((f) => ({ page: f.page, quads: f.quads })),
        what: count(found.length, "finding", "findings"),
      } satisfies RedactHandoff);
    });
    toRedact.disabled = true;
    const scan = async () => {
      const kinds = PII_KINDS.filter((k) => values[k] === true);
      const r = await api.run("pii", { kinds }, "Scanning for personal data");
      found = r?.report ?? [];
      list.replaceChildren();
      info.textContent = found.length
        ? `${count(found.length, "finding", "findings")}. Click one to see it.`
        : "Nothing found.";
      toRedact.disabled = found.length === 0;
      for (const kind of PII_KINDS) {
        const of = found.filter((f) => f.kind === kind);
        if (!of.length) {
          continue;
        }
        const ul = el("ul");
        for (const f of of) {
          const item = el(
            "button",
            { attrs: { type: "button" }, class: "finding" },
            el("span", { class: "masked", text: f.masked }),
            el("span", { class: "where", text: `page ${f.page + 1}` }),
            el("span", { class: "context", text: f.context })
          );
          item.addEventListener("click", () => {
            api.setMarks((page) =>
              page === f.page
                ? [{ kind: "quads", quads: f.quads, style: "current" }]
                : []
            );
            api.goTo(f.page, f.quads[0]?.[1]);
          });
          ul.append(el("li", {}, item));
        }
        list.append(
          el("h3", { text: `${PII_NAMES[kind as PiiKind]} (${of.length})` }),
          ul
        );
      }
    };
    const form = new Form(pii.fields ?? [], values, () => api.persist());
    api.body.replaceChildren(
      el("p", { class: "summary", text: pii.summary }),
      form.root,
      row(
        button(
          "Scan",
          () => {
            void scan();
          },
          { primary: true }
        ),
        toRedact
      ),
      info,
      list
    );
    api.foot.replaceChildren();
    return {
      destroy: () => api.setMarks(null),
      docChanged: () => list.replaceChildren(),
    };
  },
  name: "Find personal data",
  summary:
    "Look through the text for email addresses, phone numbers, payment card numbers (Luhn-checked), US Social Security numbers, and IBANs (checksum-verified). Shown masked; scanned pages need OCR first.",
};

/* ---------------- signatures ---------------- */

const CHECK_TEXT: Record<Check, string> = {
  failed: "Failed",
  ok: "Passed",
  unknown: "Not checked",
};

const verdict = (s: SignatureReport): { text: string; cls: string } => {
  if (s.integrity === "failed" || s.signature === "failed") {
    return {
      cls: "bad",
      text: "Invalid: the document or the signature has been altered",
    };
  }
  if (s.integrity === "ok" && s.signature === "ok") {
    return s.coverage === "whole"
      ? { cls: "ok", text: "Valid, and the document is unchanged since" }
      : {
          cls: "ok",
          text: "Valid for the revision it signed; changes were saved after",
        };
  }
  return { cls: "warn", text: "Could not be fully checked" };
};

const signatureCard = (s: SignatureReport): HTMLElement => {
  const v = verdict(s);
  const rows: [string, string | Node][] = [
    ["Signed by", s.signer || "(unnamed)"],
    [
      "When",
      s.signedAt
        ? `${formatDate(s.signedAt)}${s.timeSource === "timestamp" ? ", by a timestamp authority" : ", by the signer's clock"}`
        : "Not said",
    ],
    [
      "Document unchanged",
      el("span", {
        class: `verdict ${s.integrity}`,
        text: CHECK_TEXT[s.integrity],
      }),
    ],
    [
      "Signature matches",
      el("span", {
        class: `verdict ${s.signature}`,
        text: CHECK_TEXT[s.signature],
      }),
    ],
    [
      "Covers",
      s.coverage === "whole"
        ? "The whole file"
        : `All but the last ${formatBytes(s.laterBytes)} (later revisions)`,
    ],
    [
      "Algorithm",
      [s.digest, s.algorithm].filter(Boolean).join(" with ") || "Unknown",
    ],
  ];
  if (s.certificate) {
    rows.push([
      "Certificate valid then",
      el("span", {
        class: `verdict ${s.validAtSigning}`,
        text: CHECK_TEXT[s.validAtSigning],
      }),
    ]);
  }
  if (s.timestamp) {
    rows.push([
      "Timestamp",
      `${s.timestamp.authority || "Unnamed authority"}: ${CHECK_TEXT[s.timestamp.signature]}`,
    ]);
  }
  for (const [label, value] of [
    ["Reason", s.reason],
    ["Location", s.location],
    ["Contact", s.contact],
    ["Type", s.subFilter],
    ["Field", `${s.field}, page ${s.page}`],
  ] as const) {
    if (value) {
      rows.push([label, value]);
    }
  }
  const chain = el("ol", { class: "chain" });
  for (const c of s.chain) {
    chain.append(
      el(
        "li",
        {},
        el("span", { text: c.name }),
        el("span", {
          class: `verdict ${c.verified}`,
          text: c.selfSigned ? "self-signed root" : CHECK_TEXT[c.verified],
        })
      )
    );
  }
  return el(
    "div",
    { class: "sig-card" },
    el("p", { class: `verdict-line ${v.cls}`, text: v.text }),
    facts(rows),
    ...(s.chain.length
      ? [
          el("h4", { text: "Certificate chain" }),
          chain,
          el("p", {
            class: "hint",
            text: s.rootIncluded
              ? "Whether to trust its root is yours to judge: a browser shares no list of trusted authorities."
              : "The chain stops short of a root: the certificates that issued it are not in the signature.",
          }),
        ]
      : []),
    ...s.notes.map((n) => el("p", { class: "hint", text: n }))
  );
};

const signatures: PanelDef = {
  defaults: { removeFields: false },
  group: GROUP,
  id: "signatures",
  mount: (api, values) => {
    const cards = el("div", { class: "sig-cards" });
    const foot = resultFoot(api, {
      applyLabel: "removing the signatures",
      fileName: (a) => `${a.name()}-unsigned.pdf`,
    });
    const verify = async () => {
      cards.replaceChildren(el("p", { class: "sel-info", text: "Checking…" }));
      const r = await api.run("verify", {}, "Checking signatures", {
        quiet: true,
      });
      cards.replaceChildren();
      if (!r) {
        return;
      }
      const { signatures: list, empty } = r.report;
      if (list.length === 0) {
        cards.append(
          el("p", {
            class: "sel-info",
            text: empty
              ? `No signatures; ${count(empty, "empty signature field", "empty signature fields")}.`
              : "This document is not signed.",
          })
        );
      }
      const pages = api.pages();
      const [first] = pages;
      const source = api.sources().find((s) => s.key === first?.src);
      const signed = list.length > 0;
      if (signed && new Set(pages.map((p) => p.src)).size > 1) {
        cards.append(
          el("p", {
            class: "hint warn",
            text: "These pages come from several files: no signature can cover them, and the checks are of the assembled document.",
          })
        );
      } else if (signed && source && !isIdentity(pages, source.pages.length)) {
        cards.append(
          el("p", {
            class: "hint warn",
            text: "Pages were turned, moved, or removed, so the checks are of the document put together again from them, not of the file as signed: its signatures cannot hold. Undo the changes to check the file itself.",
          })
        );
      }
      cards.append(...list.map(signatureCard));
    };
    const form = new Form(
      [
        {
          key: "removeFields",
          kind: "check",
          label: "Remove the signature fields too, not just the signatures",
        },
      ],
      values,
      () => api.persist()
    );
    const remove = button("Remove signatures", async () => {
      const r = await api.run(
        "unsign",
        { removeFields: values.removeFields === true },
        "Removing signatures"
      );
      if (r?.doc) {
        api.showResult(r);
        foot.show(
          r,
          `${count(r.report.count, "signature", "signatures")} removed.`
        );
      }
    });
    api.body.replaceChildren(
      el("p", { class: "summary", text: signatures.summary }),
      cards,
      el("h3", { text: "Remove" }),
      form.root,
      row(remove),
      el("p", {
        class: "hint",
        text: "Any change to a signed document (even a turned page) breaks its signatures; removing them says so honestly.",
      })
    );
    void verify();
    return {
      docChanged: () => {
        void verify();
      },
    };
  },
  name: "Signatures",
  summary:
    "Check every digital signature: that the document is unchanged since it was signed, that the signature matches the signer's certificate, how that certificate was issued, and when it was signed.",
};

export const SECURITY_PANELS: PanelDef[] = [
  protect,
  redact,
  sanitize,
  pii,
  signatures,
];
