import LZString from "lz-string";

import "./tool.css";
import type { Tool } from "../../shell/types";
import { runAudit } from "./audit";
import type {
  AuditResult,
  AuditedPackage,
  Hit,
  InputFile,
  LockfileReport,
} from "./audit";
import type { Band } from "./cvss";
import { lockfileUrls, parseSource, sourceLabel, sourcePage } from "./github";
import type { Source } from "./github";
import { KIND_FILENAME, REASON_LABEL, detectKind } from "./lockfiles";
import type { ParsedLockfile } from "./lockfiles";
import { AuditError, browserFetch, compareSeverity } from "./osv";
import type { Advisory } from "./osv";
import {
  osvUrl,
  packageTags,
  plural,
  reportMarkdown,
  severityText,
  worstAdvisory,
} from "./report";

/** Longest compressed input we are willing to put in the Deep Link. */
const STATE_CAP = 30_000;

const BANDS: Band[] = ["critical", "high", "moderate", "low", "unknown"];

// Shown while there are no results: what leaves the browser when you audit.
const PRIVACY_NOTE =
  "An audit sends package names and versions to OSV.dev, and nothing else.";

const HTML_ESCAPES: Record<string, string> = {
  '"': "&quot;",
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

const esc = (s: string): string =>
  s.replaceAll(/[&<>"]/gu, (c) => HTML_ESCAPES[c] ?? c);

const sevPill = (a: Advisory): string =>
  `<span class="sev ${a.severity.band}"${
    a.severity.vector ? ` title="${esc(a.severity.vector)}"` : ""
  }>${esc(severityText(a))}</span>`;

const link = (href: string, text: string): string =>
  `<a href="${esc(href)}" target="_blank" rel="noreferrer">${esc(text)}</a>`;

/** The fix line under an advisory, or "" when the records say nothing either way. */
const fixLine = (fix: Hit["fix"]): string => {
  if (fix.fixed) {
    return `Fixed in ${fix.fixed}${
      fix.introduced && fix.introduced !== "0"
        ? `, affected since ${fix.introduced}`
        : ""
    }.`;
  }
  return fix.unfixed ? "No fixed version yet." : "";
};

const advisoryHtml = ({ advisory, fix }: Hit): string => {
  const aliases = advisory.aliases.length
    ? `<span class="aliases">${advisory.aliases.map(esc).join(", ")}</span>`
    : "";
  const others = advisory.ids.filter((id) => id !== advisory.id);
  const fixText = fixLine(fix);
  const failed = advisory.failed.length
    ? `<p class="note">Details for ${advisory.failed
        .map(esc)
        .join(", ")} could not be fetched.</p>`
    : "";
  return (
    `<div class="advisory" data-band="${advisory.severity.band}" data-id="${esc(
      advisory.id
    )}">` +
    `<div class="adv-head">${sevPill(advisory)}${link(
      osvUrl(advisory.id),
      advisory.id
    )}${aliases}</div>${
      advisory.summary
        ? `<p class="adv-summary">${esc(advisory.summary)}</p>`
        : ""
    }${
      fixText
        ? `<p class="adv-fix ${fix.fixed ? "has-fix" : ""}">${esc(fixText)}</p>`
        : ""
    }${failed}<details class="raw"><summary>Raw record${
      others.length ? `s (${others.map(esc).join(", ")})` : ""
    }</summary>` +
    `<div class="raw-body"><button type="button" class="btn-copy-raw inline" data-id="${esc(
      advisory.id
    )}">Copy JSON</button>` +
    `<pre class="raw-json">${esc(
      JSON.stringify(
        advisory.records.length === 1 ? advisory.records[0] : advisory.records,
        null,
        2
      )
    )}</pre></div></details></div>`
  );
};

/** The data-scope a card filters on: "direct", "transitive", or "" when the Lockfile cannot tell. */
const scopeOf = (direct: boolean | null): string => {
  if (direct === null) {
    return "";
  }
  return direct ? "direct" : "transitive";
};

const packageHtml = (ap: AuditedPackage): string => {
  const tags = packageTags(ap.pkg);
  const worst = worstAdvisory(ap);
  const scope = scopeOf(ap.pkg.direct);
  return (
    `<section class="card" data-band="${worst.severity.band}" data-scope="${
      scope
    }" data-groups="${esc(ap.pkg.groups.join(" "))}">` +
    `<div class="card-head"><span class="pkg">${esc(
      ap.pkg.name
    )}<span class="ver">@${esc(ap.pkg.version)}</span></span>${tags
      .map((t) => `<span class="tag">${esc(t)}</span>`)
      .join("")}<span class="spacer"></span><span class="hit-count">${plural(
      ap.hits.length,
      "advisory"
    )}</span>${sevPill(worst)}</div>` +
    `<div class="card-body">${ap.hits
      .map((hit) => advisoryHtml(hit))
      .join("")}</div></section>`
  );
};

const lockfileHtml = (r: LockfileReport, index: number): string => {
  const head = `<summary><span class="type-badge">${
    r.parsed ? r.parsed.ecosystem : "?"
  }</span><span class="lf-name">${esc(r.name)}</span>${
    r.parsed ? `<span class="lf-label">${esc(r.parsed.label)}</span>` : ""
  }<span class="spacer"></span><span class="count"></span></summary>`;
  if (!r.parsed) {
    return `<details class="lockfile failed" open data-file="${index}">${
      head
    }<div class="lf-body"><div class="error-box">${esc(
      r.error ?? ""
    )}</div></div></details>`;
  }
  // Worst first, then by name; clean packages keep name order.
  const affected = r.packages
    .filter((p) => p.hits.length)
    .toSorted(
      (a, b) =>
        compareSeverity(worstAdvisory(a).severity, worstAdvisory(b).severity) ||
        a.pkg.name.localeCompare(b.pkg.name)
    );
  const clean = r.packages.filter((p) => !p.hits.length);
  let body = "";
  if (!r.parsed.knowsDirect) {
    body += `<p class="note">${esc(
      r.parsed.label
    )} does not record which packages are direct dependencies, so none are tagged.</p>`;
  }
  if (!r.parsed.packages.length) {
    body += '<p class="note">No registry packages to check.</p>';
  }
  body += `<div class="cards">${affected.map(packageHtml).join("")}</div>`;
  body +=
    '<p class="note all-hidden" hidden>Every advisory here is hidden by the filters.</p>';
  if (clean.length) {
    body += `<details class="clean"><summary>${plural(
      clean.length,
      "package"
    )} without advisories</summary><div class="name-list">${clean
      .map(
        (p) =>
          `<span class="name">${esc(p.pkg.name)}<span class="ver">@${esc(
            p.pkg.version
          )}</span></span>`
      )
      .join("")}</div></details>`;
  }
  if (r.parsed.notChecked.length) {
    body += `<details class="skipped"><summary>${plural(
      r.parsed.notChecked.length,
      "entry"
    )} not checked</summary><ul class="skipped-list">${r.parsed.notChecked
      .map(
        (n) =>
          `<li><span class="name">${esc(n.name)}${
            n.version ? `<span class="ver">@${esc(n.version)}</span>` : ""
          }</span>` +
          `<span class="reason">${REASON_LABEL[n.reason]}${
            n.detail ? ` · ${esc(n.detail)}` : ""
          }</span></li>`
      )
      .join("")}</ul></details>`;
  }
  return `<details class="lockfile" open data-file="${index}">${
    head
  }<div class="lf-body">${body}</div></details>`;
};

/** The status bar's tone after an Audit: unreadable files or a critical or high advisory are errors. */
const resultTone = (failedFiles: number, r: AuditResult): string => {
  if (failedFiles) {
    return "error";
  }
  if (!r.advisories.length) {
    return "ok";
  }
  const worst = r.advisories[0]?.severity.band;
  return worst === "critical" || worst === "high" ? "error" : "";
};

/** Why a file is not a lockfile this tool reads, or "" when it is one. */
const refusalOf = (f: InputFile): string => {
  const d = detectKind(f.text, f.name);
  return d.kind === null ? d.refusal : "";
};

/** Filter settings read once per pass over the results. */
interface Filters {
  shown: Set<string>;
  scope: string;
  prodOnly: boolean;
}

/** Shows or hides one card and its advisories; returns the ids left visible. */
const filterCard = (card: HTMLElement, f: Filters): string[] => {
  const cardScope = card.dataset.scope;
  const groups = (card.dataset.groups ?? "").split(" ").filter(Boolean);
  const ok =
    !(f.scope === "d" && cardScope !== "direct") &&
    !(f.scope === "t" && cardScope !== "transitive") &&
    !(f.prodOnly && groups.includes("dev"));
  const visible: string[] = [];
  for (const adv of card.querySelectorAll(
    ".advisory"
  ) as NodeListOf<HTMLElement>) {
    const on = ok && f.shown.has(adv.dataset.band ?? "unknown");
    adv.hidden = !on;
    if (on) {
      visible.push(adv.dataset.id ?? "");
    }
  }
  card.hidden = visible.length === 0;
  return visible;
};

/** Updates a lockfile's "all hidden" note and its count after filtering. */
const showLockfileCounts = (
  lf: HTMLElement,
  lfCards: number,
  lfIds: Set<string>
) => {
  const total = lf.querySelectorAll(".card").length;
  const allHidden = lf.querySelector(".all-hidden") as HTMLElement | null;
  if (allHidden) {
    allHidden.hidden = !(total > 0 && lfCards === 0);
  }
  const count = lf.querySelector(".count") as HTMLElement | null;
  if (count && !lf.classList.contains("failed")) {
    const pkgs = Number(lf.dataset.packages ?? 0);
    count.textContent =
      lfCards === total
        ? `${plural(lfIds.size, "advisory")} in ${lfCards} of ${plural(
            pkgs,
            "package"
          )}`
        : `showing ${lfIds.size} of ${plural(
            Number(lf.dataset.advisories ?? 0),
            "advisory"
          )}`;
  }
};

const tool: Tool = {
  id: "dependency-audit",
  keywords: [
    "vulnerability",
    "vulnerabilities",
    "cve",
    "ghsa",
    "osv",
    "security",
    "audit",
    "npm",
    "pypi",
    "python",
    "javascript",
    "lockfile",
    "package-lock",
    "yarn",
    "pnpm",
    "bun",
    "uv",
    "dependencies",
    "packages",
    "advisory",
  ],
  mount(el, ctx) {
    el.innerHTML = `
      <div class="repo-row">
        <input type="text" class="repo" placeholder="owner/repo, owner/repo/dir@branch, or a GitHub URL"
          spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="GitHub repository">
        <button class="btn-fetch" type="button">Fetch<span class="wide-only"> lockfiles</span> and audit</button>
      </div>
      <section class="pane input-pane">
        <div class="pane-head">
          <span>Lockfile</span><span class="kind-label"></span>
          <span class="spacer"></span>
          <button class="btn-paste" type="button">Paste<span class="wide-only"> from clipboard</span></button>
          <button class="btn-choose" type="button">Choose<span class="wide-only"> files</span>…</button>
          <button class="btn-clear" type="button">Clear</button>
          <button class="btn-audit primary" type="button">Audit</button>
        </div>
        <textarea class="src" spellcheck="false" autocapitalize="off" autocomplete="off"
          placeholder="package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lock, or uv.lock. Paste one here, or drop files anywhere."></textarea>
        <div class="files" hidden></div>
        <input type="file" class="file-input" multiple hidden>
      </section>
      <div class="filters" hidden>
        <span class="filter-group sev-filters">${BANDS.map((b) => `<label class="opt"><input type="checkbox" class="f-sev" value="${b}" checked> <span class="sev ${b}">${b}</span></label>`).join("")}</span>
        <label class="opt">Scope <select class="f-scope"><option value="a">All</option><option value="d">Direct only</option><option value="t">Transitive only</option></select></label>
        <label class="opt">Groups <select class="f-group"><option value="a">All</option><option value="p">Production only</option></select></label>
        <label class="opt f-file-wrap" hidden>Lockfile <select class="f-file"></select></label>
      </div>
      <section class="pane results-pane">
        <div class="pane-head">
          <span class="results-title">Advisories</span><span class="spacer"></span>
          <button class="btn-markdown" type="button" disabled>Copy<span class="wide-only"> as Markdown</span></button>
        </div>
        <div class="results"><p class="note">${PRIVACY_NOTE}</p></div>
        <div class="statusbar"><span class="status-text"></span></div>
      </section>`;

    const $ = (sel: string) => el.querySelector(sel) as HTMLElement;
    const $repo = $(".repo") as HTMLInputElement;
    const $src = $(".src") as HTMLTextAreaElement;
    const $kind = $(".kind-label");
    const $files = $(".files");
    const $fileInput = $(".file-input") as HTMLInputElement;
    const $filters = $(".filters");
    const $scope = $(".f-scope") as HTMLSelectElement;
    const $group = $(".f-group") as HTMLSelectElement;
    const $fileWrap = $(".f-file-wrap");
    const $file = $(".f-file") as HTMLSelectElement;
    const $results = $(".results");
    const $resultsTitle = $(".results-title");
    const $status = $(".statusbar");
    const $statusText = $(".status-text");
    const $btnMarkdown = $(".btn-markdown") as HTMLButtonElement;
    const sevBoxes = [...el.querySelectorAll(".f-sev")] as HTMLInputElement[];
    const buttons = [
      ".btn-fetch",
      ".btn-paste",
      ".btn-choose",
      ".btn-clear",
      ".btn-audit",
    ].map((s) => $(s) as HTMLButtonElement);

    /** Files loaded by drop, upload, or Repository Fetch; the textarea is a further, unnamed one. */
    let loaded: InputFile[] = [];
    /** Where `loaded` came from when it was a Repository Fetch, for the Deep Link and the report title. */
    let source: Source | null = null;
    let result: AuditResult | null = null;
    let inflight: AbortController | null = null;

    const setStatus = (kind: string, msg: string) => {
      $status.className = `statusbar ${kind}`;
      $statusText.textContent = msg;
    };

    const inputFiles = (): InputFile[] => {
      const files = [...loaded];
      if ($src.value.trim()) {
        files.push({ name: "", text: $src.value });
      }
      return files;
    };

    /** The severity checkbox for a band; one is rendered for every band. */
    const sevBox = (band: Band): HTMLInputElement => {
      const box = sevBoxes.find((c) => c.value === band);
      if (!box) {
        throw new Error(`No severity checkbox for ${band}`);
      }
      return box;
    };

    const renderFiles = () => {
      $files.hidden = loaded.length === 0;
      $files.innerHTML = loaded
        .map((f, i) => {
          const d = detectKind(f.text, f.name);
          return `<span class="chip${
            d.kind ? "" : " bad"
          }"><span class="chip-name">${esc(f.name)}</span>${
            d.kind && !f.name.endsWith(KIND_FILENAME[d.kind])
              ? `<span class="chip-kind">${KIND_FILENAME[d.kind]}</span>`
              : ""
          }<button type="button" class="chip-x" data-index="${
            i
          }" aria-label="Remove ${esc(f.name)}">×</button></span>`;
        })
        .join("");
    };

    const syncKindLabel = () => {
      const text = $src.value;
      if (!text.trim()) {
        $kind.textContent = "";
        $kind.className = "kind-label";
        return;
      }
      const d = detectKind(text);
      $kind.textContent = d.kind ? KIND_FILENAME[d.kind] : "not a lockfile";
      $kind.className = `kind-label ${d.kind ? "ok" : "bad"}`;
      $kind.title = d.kind ? "" : d.refusal;
    };

    /* ---------------- state ---------------- */

    /** State layout: `<severity bits>.<scope>.<group>.<source>` where source is `gh:<repo shorthand>`, `lz:<compressed files>`, or empty. */
    const publishState = (): boolean => {
      const sev = BANDS.map((b) => (sevBox(b).checked ? "1" : "0")).join("");
      let src = "";
      let fits = true;
      if (source) {
        src = `gh:${encodeURIComponent(sourceLabel(source))}`;
      } else {
        const files = inputFiles();
        if (files.length) {
          const packed = LZString.compressToEncodedURIComponent(
            JSON.stringify(files.map((f) => [f.name, f.text]))
          );
          if (packed.length <= STATE_CAP) {
            src = `lz:${packed}`;
          } else {
            fits = false;
          }
        }
      }
      ctx.setState([sev, $scope.value, $group.value, src].join("."));
      return fits;
    };

    /* ---------------- filters ---------------- */

    const applyFilters = () => {
      const filters: Filters = {
        prodOnly: $group.value === "p",
        scope: $scope.value,
        shown: new Set(sevBoxes.filter((c) => c.checked).map((c) => c.value)),
      };
      const fileIndex = $file.value;
      let visibleHits = 0;
      let visibleCards = 0;
      for (const lf of $results.querySelectorAll(
        ".lockfile"
      ) as NodeListOf<HTMLElement>) {
        const fileHidden = fileIndex !== "" && lf.dataset.file !== fileIndex;
        lf.hidden = fileHidden;
        const lfIds = new Set<string>();
        let lfCards = 0;
        for (const card of lf.querySelectorAll(
          ".card"
        ) as NodeListOf<HTMLElement>) {
          const visible = filterCard(card, filters);
          for (const id of visible) {
            lfIds.add(id);
          }
          if (visible.length) {
            lfCards += 1;
          }
        }
        showLockfileCounts(lf, lfCards, lfIds);
        if (!fileHidden) {
          visibleHits += lfIds.size;
          visibleCards += lfCards;
        }
      }
      return { visibleCards, visibleHits };
    };

    const onFilterChange = () => {
      applyFilters();
      publishState();
    };

    /* ---------------- rendering ---------------- */

    const renderResult = (r: AuditResult, ms: number) => {
      result = r;
      $resultsTitle.innerHTML = `Advisories${
        source?.kind === "repo"
          ? ` · ${link(sourcePage(source), sourceLabel(source))}`
          : ""
      }`;
      $results.innerHTML = r.lockfiles.map(lockfileHtml).join("");
      for (const [i, lf] of r.lockfiles.entries()) {
        const node = $results.querySelector(
          `.lockfile[data-file="${i}"]`
        ) as HTMLElement;
        node.dataset.packages = String(lf.parsed?.packages.length ?? 0);
        node.dataset.advisories = String(
          new Set(lf.packages.flatMap((p) => p.hits.map((h) => h.advisory.id)))
            .size
        );
      }
      $filters.hidden = false;
      const readable = r.lockfiles.filter(
        (lf): lf is LockfileReport & { parsed: ParsedLockfile } =>
          lf.parsed !== null
      );
      $fileWrap.hidden = r.lockfiles.length < 2;
      $file.innerHTML = `<option value="">All</option>${r.lockfiles
        .map((lf, i) => `<option value="${i}">${esc(lf.name)}</option>`)
        .join("")}`;
      $file.value = "";
      $btnMarkdown.disabled = false;
      applyFilters();
      const packages = readable.reduce(
        (n, lf) => n + lf.parsed.packages.length,
        0
      );
      const affected = readable.reduce(
        (n, lf) => n + lf.packages.filter((p) => p.hits.length).length,
        0
      );
      const failedFiles = r.lockfiles.length - readable.length;
      setStatus(
        resultTone(failedFiles, r),
        `${
          r.advisories.length
            ? `${plural(r.advisories.length, "advisory")} in ${plural(
                affected,
                "package"
              )}`
            : "no advisories"
        } · ${plural(packages, "package")} checked${
          r.failedRecords.length
            ? ` · ${plural(
                r.failedRecords.length,
                "record"
              )} could not be fetched`
            : ""
        }${
          failedFiles
            ? ` · ${plural(failedFiles, "file")} could not be read`
            : ""
        } · OSV.dev · ${ms} ms`
      );
    };

    /* ---------------- running ---------------- */

    const begin = (): AbortController => {
      inflight?.abort();
      const ctrl = new AbortController();
      inflight = ctrl;
      for (const b of buttons) {
        b.disabled = true;
      }
      return ctrl;
    };

    const finish = (ctrl: AbortController) => {
      if (inflight !== ctrl) {
        return;
      }
      inflight = null;
      for (const b of buttons) {
        b.disabled = false;
      }
    };

    const fail = (ctrl: AbortController, e: unknown) => {
      if (ctrl.signal.aborted) {
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      $resultsTitle.textContent = "Advisories";
      $results.innerHTML = `<div class="error-box">${esc(msg)}</div>`;
      $filters.hidden = true;
      $btnMarkdown.disabled = true;
      result = null;
      setStatus("error", msg);
    };

    const audit = async (ctrl: AbortController) => {
      const files = inputFiles();
      if (!files.length) {
        setStatus("error", "Paste or drop a lockfile first.");
        $src.focus();
        return;
      }
      const started = performance.now();
      const fits = publishState();
      setStatus("", `Reading ${plural(files.length, "lockfile")}…`);
      $results.replaceChildren();
      const r = await runAudit(files, browserFetch, ctrl.signal, (msg) => {
        if (!ctrl.signal.aborted) {
          setStatus("", msg);
        }
      });
      if (ctrl.signal.aborted) {
        return;
      }
      renderResult(r, Math.round(performance.now() - started));
      if (!fits) {
        $statusText.textContent += " · too large to keep in the URL";
      }
    };

    const runAuditClick = async () => {
      const ctrl = begin();
      try {
        await audit(ctrl);
      } catch (error) {
        fail(ctrl, error);
      } finally {
        finish(ctrl);
      }
    };

    /** GET a text file; null on 404 or a cross-origin refusal, which is what GitHub answers for anything private. */
    const fetchText = async (
      url: string,
      signal: AbortSignal
    ): Promise<string | null> => {
      let res: Response;
      try {
        res = await fetch(url, { signal });
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        return null;
      }
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        throw new AuditError(
          `HTTP ${res.status} from ${new URL(url).host} for ${url
            .split("/")
            .pop()}`
        );
      }
      return res.text();
    };

    /** Reads the Lockfiles at a source into `loaded`, replacing whatever was there, then audits. */
    const runFetch = async (src: Source) => {
      const ctrl = begin();
      try {
        setStatus("", `Fetching lockfiles from ${sourceLabel(src)}…`);
        $results.replaceChildren();
        const files: InputFile[] = [];
        if (src.kind === "file") {
          const text = await fetchText(src.url, ctrl.signal);
          if (text === null) {
            throw new AuditError(
              `Nothing readable at ${
                src.url
              } (HTTP 404 or no cross-origin access).`
            );
          }
          files.push({ name: src.filename || "fetched", text });
        } else {
          const found = await Promise.all(
            lockfileUrls(src).map(async ({ name, url }) => {
              const text = await fetchText(url, ctrl.signal);
              return text === null ? null : { name, text };
            })
          );
          for (const f of found) {
            if (f) {
              files.push(f);
            }
          }
          if (!files.length) {
            throw new AuditError(
              `No lockfile at ${sourceLabel(src)}: looked for ${lockfileUrls(
                src
              )
                .map((l) => l.name)
                .join(", ")}${
                src.dir ? ` in ${src.dir}` : " at the repository root"
              }. Private repositories cannot be read.`
            );
          }
        }
        if (ctrl.signal.aborted) {
          return;
        }
        loaded = files;
        source = src;
        $src.value = "";
        syncKindLabel();
        renderFiles();
        await audit(ctrl);
      } catch (error) {
        fail(ctrl, error);
      } finally {
        finish(ctrl);
      }
    };

    const fetchClick = () => {
      const src = parseSource($repo.value);
      if (!src) {
        setStatus(
          "error",
          "Enter a repository as owner/repo, optionally with /dir and @branch, or a GitHub URL."
        );
        $repo.focus();
        return;
      }
      $repo.value = sourceLabel(src);
      void runFetch(src);
    };

    /* ---------------- input ---------------- */

    /** Reads one dropped or chosen file into `loaded`, replacing a file of the same name. */
    const readFile = async (f: File) => {
      try {
        const text = await f.text();
        loaded = loaded.filter((x) => x.name !== f.name);
        loaded.push({ name: f.name, text });
      } catch {
        setStatus("error", `Could not read ${f.name}.`);
      }
    };

    const addFiles = async (files: FileList | File[]) => {
      const list = [...files];
      if (!list.length) {
        return;
      }
      source = null;
      // Each file lands in `loaded` as soon as it is read; the summary waits for all of them.
      await Promise.all(list.map((f) => readFile(f)));
      renderFiles();
      publishState();
      const bad = loaded.filter((x) => !detectKind(x.text, x.name).kind);
      const [firstBad] = bad;
      setStatus(
        firstBad ? "error" : "",
        `${plural(loaded.length, "file")} loaded${
          firstBad
            ? ` · ${bad.map((x) => x.name).join(", ")}: ${refusalOf(firstBad)}`
            : ""
        }`
      );
    };

    let kindTimer: ReturnType<typeof setTimeout>;
    $src.addEventListener("input", () => {
      source = null;
      clearTimeout(kindTimer);
      kindTimer = setTimeout(syncKindLabel, 120);
    });

    $(".btn-audit").addEventListener("click", () => {
      void runAuditClick();
    });
    $(".btn-fetch").addEventListener("click", fetchClick);
    $repo.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        fetchClick();
      }
    });
    $(".btn-choose").addEventListener("click", () => $fileInput.click());
    $fileInput.addEventListener("change", () => {
      if ($fileInput.files) {
        void addFiles($fileInput.files);
      }
      $fileInput.value = "";
    });
    $(".btn-paste").addEventListener("click", async () => {
      try {
        $src.value = await navigator.clipboard.readText();
        source = null;
        syncKindLabel();
        setStatus("", "");
      } catch {
        setStatus(
          "error",
          "The browser blocked clipboard access. Paste with the keyboard instead."
        );
      }
    });
    $(".btn-clear").addEventListener("click", () => {
      inflight?.abort();
      loaded = [];
      source = null;
      result = null;
      $src.value = "";
      $repo.value = "";
      syncKindLabel();
      renderFiles();
      $resultsTitle.textContent = "Advisories";
      $results.innerHTML = `<p class="note">${PRIVACY_NOTE}</p>`;
      $filters.hidden = true;
      $btnMarkdown.disabled = true;
      setStatus("", "");
      publishState();
      $src.focus();
    });
    $files.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest(
        ".chip-x"
      ) as HTMLElement | null;
      if (!btn) {
        return;
      }
      loaded.splice(Number(btn.dataset.index), 1);
      source = null;
      renderFiles();
      publishState();
    });

    // Drop lockfiles anywhere on the tool.
    let dragDepth = 0;
    el.addEventListener("dragenter", (e) => {
      e.preventDefault();
      dragDepth += 1;
      el.classList.add("dragging");
    });
    el.addEventListener("dragover", (e) => e.preventDefault());
    el.addEventListener("dragleave", () => {
      dragDepth -= 1;
      if (dragDepth <= 0) {
        dragDepth = 0;
        el.classList.remove("dragging");
      }
    });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      el.classList.remove("dragging");
      if (e.dataTransfer?.files.length) {
        void addFiles(e.dataTransfer.files);
      }
    });

    for (const c of sevBoxes) {
      c.addEventListener("change", onFilterChange);
    }
    $scope.addEventListener("change", onFilterChange);
    $group.addEventListener("change", onFilterChange);
    $file.addEventListener("change", () => applyFilters());

    /* ---------------- copying ---------------- */

    const copyText = async (text: string, btn: HTMLButtonElement) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.append(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      const old = btn.innerHTML;
      btn.textContent = "Copied";
      setTimeout(() => {
        btn.innerHTML = old;
      }, 1200);
    };

    $btnMarkdown.addEventListener("click", () => {
      if (!result) {
        return;
      }
      void copyText(
        reportMarkdown(result, source ? sourceLabel(source) : null),
        $btnMarkdown
      );
    });

    $results.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest(
        ".btn-copy-raw"
      ) as HTMLButtonElement | null;
      if (!btn || !result) {
        return;
      }
      const advisory = result.advisories.find((a) => a.id === btn.dataset.id);
      if (advisory) {
        void copyText(
          JSON.stringify(
            advisory.records.length === 1
              ? advisory.records[0]
              : advisory.records,
            null,
            2
          ),
          btn
        );
      }
    });

    /* ---------------- deep link ---------------- */

    /** Restores a `gh:` source: fetches the repository it names and audits. */
    const restoreRepo = (encoded: string) => {
      let label = "";
      try {
        label = decodeURIComponent(encoded);
      } catch {
        /* not ours */
      }
      const parsed = label ? parseSource(label) : null;
      if (parsed) {
        $repo.value = sourceLabel(parsed);
        void runFetch(parsed);
      }
    };

    /** Restores an `lz:` source: the compressed files go back into the inputs and are audited. */
    const restoreFiles = (packed: string) => {
      const text = LZString.decompressFromEncodedURIComponent(packed);
      let files: [string, string][] = [];
      try {
        files = JSON.parse(text || "[]");
      } catch {
        /* not ours */
      }
      if (!Array.isArray(files) || !files.length) {
        return;
      }
      loaded = [];
      for (const [name, body] of files) {
        if (typeof body !== "string") {
          continue;
        }
        if (name) {
          loaded.push({ name, text: body });
        } else {
          $src.value = body;
        }
      }
      syncKindLabel();
      renderFiles();
      void runAuditClick();
    };

    ctx.onRestore((payload) => {
      const [sev, scope, group, ...rest] = payload.split(".");
      const src = rest.join(".");
      if (sev && /^[01]{5}$/u.test(sev)) {
        for (const [i, b] of BANDS.entries()) {
          sevBox(b).checked = sev[i] === "1";
        }
      }
      if (scope === "a" || scope === "d" || scope === "t") {
        $scope.value = scope;
      }
      if (group === "a" || group === "p") {
        $group.value = group;
      }
      if (src.startsWith("gh:")) {
        restoreRepo(src.slice(3));
      } else if (src.startsWith("lz:")) {
        restoreFiles(src.slice(3));
      }
    });
  },
  name: "Dependency Audit",
  subtitle:
    "Check every package in a lockfile against the OSV.dev vulnerability database.",
};

export default tool;
