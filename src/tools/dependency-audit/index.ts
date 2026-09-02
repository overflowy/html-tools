import LZString from "lz-string";
import "./tool.css";
import type { Tool } from "../../shell/types";
import { runAudit, type AuditResult, type AuditedPackage, type InputFile, type LockfileReport } from "./audit";
import type { Band } from "./cvss";
import { lockfileUrls, parseSource, sourceLabel, sourcePage, type Source } from "./github";
import { KIND_FILENAME, REASON_LABEL, detectKind } from "./lockfiles";
import { AuditError, browserFetch, compareSeverity, type Advisory } from "./osv";
import { osvUrl, packageTags, plural, reportMarkdown, severityText } from "./report";

/** Longest compressed input we are willing to put in the Deep Link. */
const STATE_CAP = 30000;

const BANDS: Band[] = ["critical", "high", "moderate", "low", "unknown"];

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function sevPill(a: Advisory): string {
  return '<span class="sev ' + a.severity.band + '"' + (a.severity.vector ? ' title="' + esc(a.severity.vector) + '"' : "") + ">" + esc(severityText(a)) + "</span>";
}

function link(href: string, text: string): string {
  return '<a href="' + esc(href) + '" target="_blank" rel="noreferrer">' + esc(text) + "</a>";
}

function advisoryHtml(ap: AuditedPackage, index: number): string {
  const { advisory, fix } = ap.hits[index]!;
  const aliases = advisory.aliases.length ? '<span class="aliases">' + advisory.aliases.map(esc).join(", ") + "</span>" : "";
  const others = advisory.ids.filter((id) => id !== advisory.id);
  const fixText = fix.fixed
    ? "Fixed in " + fix.fixed + (fix.introduced && fix.introduced !== "0" ? ", affected since " + fix.introduced : "") + "."
    : fix.unfixed ? "No fixed version yet." : "";
  const failed = advisory.failed.length ? '<p class="note">Details for ' + advisory.failed.map(esc).join(", ") + " could not be fetched.</p>" : "";
  return '<div class="advisory" data-band="' + advisory.severity.band + '" data-id="' + esc(advisory.id) + '">' +
    '<div class="adv-head">' + sevPill(advisory) + link(osvUrl(advisory.id), advisory.id) + aliases + "</div>" +
    (advisory.summary ? '<p class="adv-summary">' + esc(advisory.summary) + "</p>" : "") +
    (fixText ? '<p class="adv-fix ' + (fix.fixed ? "has-fix" : "") + '">' + esc(fixText) + "</p>" : "") +
    failed +
    '<details class="raw"><summary>raw record' + (others.length ? "s (" + others.map(esc).join(", ") + ")" : "") + "</summary>" +
    '<div class="raw-body"><button type="button" class="btn-copy-raw" data-id="' + esc(advisory.id) + '">Copy JSON</button>' +
    '<pre class="raw-json">' + esc(JSON.stringify(advisory.records.length === 1 ? advisory.records[0] : advisory.records, null, 2)) + "</pre></div></details></div>";
}

function packageHtml(ap: AuditedPackage): string {
  const tags = packageTags(ap.pkg);
  const worst = ap.hits[0]!.advisory;
  const scope = ap.pkg.direct === true ? "direct" : ap.pkg.direct === false ? "transitive" : "";
  return '<section class="card" data-band="' + worst.severity.band + '" data-scope="' + scope + '" data-groups="' + esc(ap.pkg.groups.join(" ")) + '">' +
    '<div class="card-head"><span class="pkg">' + esc(ap.pkg.name) + '<span class="ver">@' + esc(ap.pkg.version) + "</span></span>" +
    tags.map((t) => '<span class="tag">' + esc(t) + "</span>").join("") +
    '<span class="spacer"></span><span class="hit-count">' + plural(ap.hits.length, "advisory") + "</span>" + sevPill(worst) + "</div>" +
    '<div class="card-body">' + ap.hits.map((_, i) => advisoryHtml(ap, i)).join("") + "</div></section>";
}

function lockfileHtml(r: LockfileReport, index: number): string {
  const head = '<summary><span class="type-badge">' + (r.parsed ? r.parsed.ecosystem : "?") + '</span><span class="lf-name">' + esc(r.name) + "</span>" +
    (r.parsed ? '<span class="lf-label">' + esc(r.parsed.label) + "</span>" : "") + '<span class="spacer"></span><span class="count"></span></summary>';
  if (!r.parsed) {
    return '<details class="lockfile failed" open data-file="' + index + '">' + head + '<div class="lf-body"><div class="error-box">' + esc(r.error ?? "") + "</div></div></details>";
  }
  // Worst first, then by name; clean packages keep name order.
  const affected = r.packages.filter((p) => p.hits.length)
    .toSorted((a, b) => compareSeverity(a.hits[0]!.advisory.severity, b.hits[0]!.advisory.severity) || a.pkg.name.localeCompare(b.pkg.name));
  const clean = r.packages.filter((p) => !p.hits.length);
  let body = "";
  if (!r.parsed.knowsDirect) body += '<p class="note">' + esc(r.parsed.label) + " does not record which packages are direct dependencies, so none are tagged.</p>";
  if (!r.parsed.packages.length) body += '<p class="note">No registry packages to check.</p>';
  body += '<div class="cards">' + affected.map(packageHtml).join("") + "</div>";
  body += '<p class="note all-hidden" hidden>Every advisory here is hidden by the filters.</p>';
  if (clean.length) {
    body += '<details class="clean"><summary>' + plural(clean.length, "package") + ' without advisories</summary><div class="name-list">' +
      clean.map((p) => '<span class="name">' + esc(p.pkg.name) + '<span class="ver">@' + esc(p.pkg.version) + "</span></span>").join("") + "</div></details>";
  }
  if (r.parsed.notChecked.length) {
    body += '<details class="skipped"><summary>' + plural(r.parsed.notChecked.length, "entry") + ' not checked</summary><ul class="skipped-list">' +
      r.parsed.notChecked.map((n) => "<li><span class=\"name\">" + esc(n.name) + (n.version ? '<span class="ver">@' + esc(n.version) + "</span>" : "") + "</span>" +
        '<span class="reason">' + REASON_LABEL[n.reason] + (n.detail ? " · " + esc(n.detail) : "") + "</span></li>").join("") + "</ul></details>";
  }
  return '<details class="lockfile" open data-file="' + index + '">' + head + '<div class="lf-body">' + body + "</div></details>";
}

const tool: Tool = {
  id: "dependency-audit",
  name: "Dependency Audit",
  subtitle: "Check every package in a lockfile against OSV.dev: package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lock, and uv.lock, pasted, dropped, or fetched from GitHub.",
  keywords: ["vulnerability", "vulnerabilities", "cve", "ghsa", "osv", "security", "audit", "npm", "pypi", "python", "javascript", "lockfile",
    "package-lock", "yarn", "pnpm", "bun", "uv", "dependencies", "packages", "advisory"],
  mount(el, ctx) {
    el.innerHTML = `
      <div class="repo-row">
        <input type="text" class="repo" placeholder="owner/repo, owner/repo/dir@branch, or a GitHub URL"
          spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="GitHub repository">
        <button class="btn-fetch" type="button">Fetch<span class="wide-only"> lockfiles</span> and audit</button>
      </div>
      <section class="pane input-pane">
        <div class="pane-head">
          <span>lockfile</span><span class="kind-label"></span>
          <span class="spacer"></span>
          <button class="btn-paste" type="button">Paste<span class="wide-only"> from clipboard</span></button>
          <button class="btn-choose" type="button">Choose<span class="wide-only"> files</span>…</button>
          <button class="btn-clear" type="button">Clear</button>
          <button class="btn-audit primary" type="button">Audit</button>
        </div>
        <textarea class="src" spellcheck="false" autocapitalize="off" autocomplete="off"
          placeholder="Paste a lockfile: package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lock, or uv.lock. Or drop lockfiles anywhere on this tool."></textarea>
        <div class="files" hidden></div>
        <input type="file" class="file-input" multiple hidden>
      </section>
      <div class="filters" hidden>
        <span class="filter-group sev-filters">${BANDS.map((b) => '<label class="opt"><input type="checkbox" class="f-sev" value="' + b + '" checked> <span class="sev ' + b + '">' + b + "</span></label>").join("")}</span>
        <label class="opt">scope <select class="f-scope"><option value="a">all</option><option value="d">direct only</option><option value="t">transitive only</option></select></label>
        <label class="opt">groups <select class="f-group"><option value="a">all</option><option value="p">production only</option></select></label>
        <label class="opt f-file-wrap" hidden>lockfile <select class="f-file"></select></label>
      </div>
      <section class="pane results-pane">
        <div class="pane-head">
          <span class="results-title">advisories</span><span class="spacer"></span>
          <button class="btn-markdown" type="button" disabled>Copy<span class="wide-only"> as Markdown</span></button>
        </div>
        <div class="results"><p class="note">Paste or drop a lockfile, or name a GitHub repository, then press Audit. Package names and versions are sent to OSV.dev; nothing else leaves the browser.</p></div>
        <div class="statusbar"><span class="dot">&#9679;</span><span class="status-text">Waiting for a lockfile</span></div>
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
    const buttons = [".btn-fetch", ".btn-paste", ".btn-choose", ".btn-clear", ".btn-audit"].map((s) => $(s) as HTMLButtonElement);

    /** Files loaded by drop, upload, or Repository Fetch; the textarea is a further, unnamed one. */
    let loaded: InputFile[] = [];
    /** Where `loaded` came from when it was a Repository Fetch, for the Deep Link and the report title. */
    let source: Source | null = null;
    let result: AuditResult | null = null;
    let inflight: AbortController | null = null;

    function setStatus(kind: string, msg: string) {
      $status.className = "statusbar " + kind;
      $statusText.textContent = msg;
    }

    function inputFiles(): InputFile[] {
      const files = [...loaded];
      if ($src.value.trim()) files.push({ name: "", text: $src.value });
      return files;
    }

    function renderFiles() {
      $files.hidden = loaded.length === 0;
      $files.innerHTML = loaded.map((f, i) => {
        const d = detectKind(f.text, f.name);
        return '<span class="chip' + (d.kind ? "" : " bad") + '"><span class="chip-name">' + esc(f.name) + "</span>" +
          (d.kind && !f.name.endsWith(KIND_FILENAME[d.kind]) ? '<span class="chip-kind">' + KIND_FILENAME[d.kind] + "</span>" : "") +
          '<button type="button" class="chip-x" data-index="' + i + '" aria-label="Remove ' + esc(f.name) + '">×</button></span>';
      }).join("");
    }

    function syncKindLabel() {
      const text = $src.value;
      if (!text.trim()) { $kind.textContent = ""; $kind.className = "kind-label"; return; }
      const d = detectKind(text);
      $kind.textContent = d.kind ? KIND_FILENAME[d.kind] : "not a lockfile";
      $kind.className = "kind-label " + (d.kind ? "ok" : "bad");
      $kind.title = d.kind ? "" : d.refusal;
    }

    /* ---------------- state ---------------- */

    /** State layout: `<severity bits>.<scope>.<group>.<source>` where source is `gh:<repo shorthand>`, `lz:<compressed files>`, or empty. */
    function publishState(): boolean {
      const sev = BANDS.map((b) => (sevBoxes.find((c) => c.value === b)!.checked ? "1" : "0")).join("");
      let src = "";
      let fits = true;
      if (source) {
        src = "gh:" + encodeURIComponent(sourceLabel(source));
      } else {
        const files = inputFiles();
        if (files.length) {
          const packed = LZString.compressToEncodedURIComponent(JSON.stringify(files.map((f) => [f.name, f.text])));
          if (packed.length <= STATE_CAP) src = "lz:" + packed;
          else fits = false;
        }
      }
      ctx.setState([sev, $scope.value, $group.value, src].join("."));
      return fits;
    }

    /* ---------------- filters ---------------- */

    function applyFilters() {
      const shown = new Set(sevBoxes.filter((c) => c.checked).map((c) => c.value));
      const scope = $scope.value;
      const prodOnly = $group.value === "p";
      const fileIndex = $file.value;
      let visibleHits = 0, visibleCards = 0;
      for (const lf of $results.querySelectorAll(".lockfile") as NodeListOf<HTMLElement>) {
        const fileHidden = fileIndex !== "" && lf.dataset.file !== fileIndex;
        lf.hidden = fileHidden;
        const lfIds = new Set<string>();
        let lfCards = 0;
        for (const card of lf.querySelectorAll(".card") as NodeListOf<HTMLElement>) {
          const cardScope = card.dataset.scope;
          const groups = (card.dataset.groups ?? "").split(" ").filter(Boolean);
          let ok = !(scope === "d" && cardScope !== "direct") && !(scope === "t" && cardScope !== "transitive");
          if (prodOnly && groups.includes("dev")) ok = false;
          let cardHits = 0;
          for (const adv of card.querySelectorAll(".advisory") as NodeListOf<HTMLElement>) {
            const on = ok && shown.has(adv.dataset.band ?? "unknown");
            adv.hidden = !on;
            if (on) { cardHits++; lfIds.add(adv.dataset.id ?? ""); }
          }
          card.hidden = cardHits === 0;
          if (cardHits) lfCards++;
        }
        const total = lf.querySelectorAll(".card").length;
        const allHidden = lf.querySelector(".all-hidden") as HTMLElement | null;
        if (allHidden) allHidden.hidden = !(total > 0 && lfCards === 0);
        const count = lf.querySelector(".count") as HTMLElement | null;
        if (count && !lf.classList.contains("failed")) {
          const pkgs = Number(lf.dataset.packages ?? 0);
          count.textContent = lfCards === total
            ? plural(lfIds.size, "advisory") + " in " + lfCards + " of " + plural(pkgs, "package")
            : "showing " + lfIds.size + " of " + plural(Number(lf.dataset.advisories ?? 0), "advisory");
        }
        if (!fileHidden) { visibleHits += lfIds.size; visibleCards += lfCards; }
      }
      return { visibleHits, visibleCards };
    }

    function onFilterChange() {
      applyFilters();
      publishState();
    }

    /* ---------------- rendering ---------------- */

    function renderResult(r: AuditResult, ms: number) {
      result = r;
      $resultsTitle.innerHTML = "advisories" + (source?.kind === "repo" ? " · " + link(sourcePage(source), sourceLabel(source)) : "");
      $results.innerHTML = r.lockfiles.map(lockfileHtml).join("");
      r.lockfiles.forEach((lf, i) => {
        const node = $results.querySelector('.lockfile[data-file="' + i + '"]') as HTMLElement;
        node.dataset.packages = String(lf.parsed?.packages.length ?? 0);
        node.dataset.advisories = String(new Set(lf.packages.flatMap((p) => p.hits.map((h) => h.advisory.id))).size);
      });
      $filters.hidden = false;
      const readable = r.lockfiles.filter((lf) => lf.parsed);
      $fileWrap.hidden = r.lockfiles.length < 2;
      $file.innerHTML = '<option value="">all</option>' + r.lockfiles.map((lf, i) => '<option value="' + i + '">' + esc(lf.name) + "</option>").join("");
      $file.value = "";
      $btnMarkdown.disabled = false;
      applyFilters();
      const packages = readable.reduce((n, lf) => n + lf.parsed!.packages.length, 0);
      const affected = readable.reduce((n, lf) => n + lf.packages.filter((p) => p.hits.length).length, 0);
      const failedFiles = r.lockfiles.length - readable.length;
      const worst = r.advisories[0]?.severity.band;
      setStatus(failedFiles ? "error" : r.advisories.length ? (worst === "critical" || worst === "high" ? "error" : "") : "ok",
        (r.advisories.length ? plural(r.advisories.length, "advisory") + " in " + plural(affected, "package") : "no advisories") +
        " · " + plural(packages, "package") + " checked" +
        (r.failedRecords.length ? " · " + plural(r.failedRecords.length, "record") + " could not be fetched" : "") +
        (failedFiles ? " · " + plural(failedFiles, "file") + " could not be read" : "") +
        " · OSV.dev · " + ms + " ms");
    }

    /* ---------------- running ---------------- */

    function begin(): AbortController {
      inflight?.abort();
      const ctrl = new AbortController();
      inflight = ctrl;
      for (const b of buttons) b.disabled = true;
      return ctrl;
    }

    function finish(ctrl: AbortController) {
      if (inflight !== ctrl) return;
      inflight = null;
      for (const b of buttons) b.disabled = false;
    }

    function fail(ctrl: AbortController, e: unknown) {
      if (ctrl.signal.aborted) return;
      const msg = e instanceof Error ? e.message : String(e);
      $resultsTitle.textContent = "advisories";
      $results.innerHTML = '<div class="error-box">' + esc(msg) + "</div>";
      $filters.hidden = true;
      $btnMarkdown.disabled = true;
      result = null;
      setStatus("error", msg);
    }

    async function audit(ctrl: AbortController) {
      const files = inputFiles();
      if (!files.length) {
        setStatus("error", "Paste or drop a lockfile first.");
        $src.focus();
        return;
      }
      const started = performance.now();
      const fits = publishState();
      setStatus("", "Reading " + plural(files.length, "lockfile") + "…");
      $results.innerHTML = '<p class="note">Reading ' + plural(files.length, "lockfile") + "…</p>";
      const r = await runAudit(files, browserFetch, ctrl.signal, (msg) => {
        if (!ctrl.signal.aborted) setStatus("", msg);
      });
      if (ctrl.signal.aborted) return;
      renderResult(r, Math.round(performance.now() - started));
      if (!fits) $statusText.textContent += " · too large to keep in the URL";
    }

    async function runAuditClick() {
      const ctrl = begin();
      try {
        await audit(ctrl);
      } catch (e) {
        fail(ctrl, e);
      } finally {
        finish(ctrl);
      }
    }

    /** Reads the Lockfiles at a source into `loaded`, replacing whatever was there, then audits. */
    async function runFetch(src: Source) {
      const ctrl = begin();
      try {
        setStatus("", "Fetching lockfiles from " + sourceLabel(src) + "…");
        $results.innerHTML = '<p class="note">Fetching from ' + esc(sourceLabel(src)) + "…</p>";
        const files: InputFile[] = [];
        if (src.kind === "file") {
          const text = await fetchText(src.url, ctrl.signal);
          if (text === null) throw new AuditError("Nothing readable at " + src.url + " (HTTP 404 or no cross-origin access).");
          files.push({ name: src.filename || "fetched", text });
        } else {
          const found = await Promise.all(lockfileUrls(src).map(async ({ name, url }) => {
            const text = await fetchText(url, ctrl.signal);
            return text === null ? null : { name, text };
          }));
          for (const f of found) if (f) files.push(f);
          if (!files.length) {
            throw new AuditError("No lockfile at " + sourceLabel(src) + ": looked for " + lockfileUrls(src).map((l) => l.name).join(", ") +
              (src.dir ? " in " + src.dir : " at the repository root") + ". Private repositories cannot be read.");
          }
        }
        if (ctrl.signal.aborted) return;
        loaded = files;
        source = src;
        $src.value = "";
        syncKindLabel();
        renderFiles();
        await audit(ctrl);
      } catch (e) {
        fail(ctrl, e);
      } finally {
        finish(ctrl);
      }
    }

    /** GET a text file; null on 404 or a cross-origin refusal, which is what GitHub answers for anything private. */
    async function fetchText(url: string, signal: AbortSignal): Promise<string | null> {
      let res: Response;
      try {
        res = await fetch(url, { signal });
      } catch (e) {
        if (signal.aborted) throw e;
        return null;
      }
      if (res.status === 404) return null;
      if (!res.ok) throw new AuditError("HTTP " + res.status + " from " + new URL(url).host + " for " + url.split("/").pop());
      return res.text();
    }

    function fetchClick() {
      const src = parseSource($repo.value);
      if (!src) {
        setStatus("error", "Enter a repository as owner/repo, optionally with /dir and @branch, or a GitHub URL.");
        $repo.focus();
        return;
      }
      $repo.value = sourceLabel(src);
      void runFetch(src);
    }

    /* ---------------- input ---------------- */

    function addFiles(files: FileList | File[]) {
      const list = [...files];
      if (!list.length) return;
      source = null;
      let pending = list.length;
      for (const f of list) {
        f.text().then((text) => {
          loaded = loaded.filter((x) => x.name !== f.name);
          loaded.push({ name: f.name, text });
        }, () => {
          setStatus("error", "Could not read " + f.name + ".");
        }).finally(() => {
          if (--pending === 0) {
            renderFiles();
            publishState();
            const bad = loaded.filter((x) => !detectKind(x.text, x.name).kind);
            setStatus(bad.length ? "error" : "", plural(loaded.length, "file") + " loaded" +
              (bad.length ? " · " + bad.map((x) => x.name).join(", ") + ": " + (detectKind(bad[0]!.text, bad[0]!.name) as { refusal: string }).refusal : " · press Audit"));
          }
        });
      }
    }

    let kindTimer: ReturnType<typeof setTimeout>;
    $src.addEventListener("input", () => {
      source = null;
      clearTimeout(kindTimer);
      kindTimer = setTimeout(syncKindLabel, 120);
    });

    $(".btn-audit").addEventListener("click", () => void runAuditClick());
    $(".btn-fetch").addEventListener("click", fetchClick);
    $repo.addEventListener("keydown", (e) => { if (e.key === "Enter") fetchClick(); });
    $(".btn-choose").addEventListener("click", () => $fileInput.click());
    $fileInput.addEventListener("change", () => {
      if ($fileInput.files) addFiles($fileInput.files);
      $fileInput.value = "";
    });
    $(".btn-paste").addEventListener("click", async () => {
      try {
        $src.value = await navigator.clipboard.readText();
        source = null;
        syncKindLabel();
        setStatus("", "Pasted · press Audit");
      } catch {
        setStatus("error", "Clipboard access denied. Paste manually into the text area instead.");
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
      $resultsTitle.textContent = "advisories";
      $results.innerHTML = '<p class="note">Paste or drop a lockfile, or name a GitHub repository, then press Audit.</p>';
      $filters.hidden = true;
      $btnMarkdown.disabled = true;
      setStatus("", "Waiting for a lockfile");
      publishState();
      $src.focus();
    });
    $files.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest(".chip-x") as HTMLElement | null;
      if (!btn) return;
      loaded.splice(Number(btn.dataset.index), 1);
      source = null;
      renderFiles();
      publishState();
    });

    // Drop lockfiles anywhere on the tool.
    let dragDepth = 0;
    el.addEventListener("dragenter", (e) => {
      e.preventDefault();
      dragDepth++;
      el.classList.add("dragging");
    });
    el.addEventListener("dragover", (e) => e.preventDefault());
    el.addEventListener("dragleave", () => {
      if (--dragDepth <= 0) {
        dragDepth = 0;
        el.classList.remove("dragging");
      }
    });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      el.classList.remove("dragging");
      if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
    });

    for (const c of sevBoxes) c.addEventListener("change", onFilterChange);
    $scope.addEventListener("change", onFilterChange);
    $group.addEventListener("change", onFilterChange);
    $file.addEventListener("change", () => applyFilters());

    /* ---------------- copying ---------------- */

    async function copyText(text: string, btn: HTMLButtonElement) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      const old = btn.innerHTML;
      btn.textContent = "Copied";
      setTimeout(() => { btn.innerHTML = old; }, 1200);
    }

    $btnMarkdown.addEventListener("click", () => {
      if (!result) return;
      void copyText(reportMarkdown(result, source ? sourceLabel(source) : null), $btnMarkdown);
    });

    $results.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest(".btn-copy-raw") as HTMLButtonElement | null;
      if (!btn || !result) return;
      const advisory = result.advisories.find((a) => a.id === btn.dataset.id);
      if (advisory) void copyText(JSON.stringify(advisory.records.length === 1 ? advisory.records[0] : advisory.records, null, 2), btn);
    });

    /* ---------------- deep link ---------------- */

    ctx.onRestore((payload) => {
      const [sev, scope, group, ...rest] = payload.split(".");
      const src = rest.join(".");
      if (sev && /^[01]{5}$/.test(sev)) BANDS.forEach((b, i) => { sevBoxes.find((c) => c.value === b)!.checked = sev[i] === "1"; });
      if (scope === "a" || scope === "d" || scope === "t") $scope.value = scope;
      if (group === "a" || group === "p") $group.value = group;
      if (src.startsWith("gh:")) {
        let label = "";
        try { label = decodeURIComponent(src.slice(3)); } catch { /* not ours */ }
        const parsed = label ? parseSource(label) : null;
        if (parsed) {
          $repo.value = sourceLabel(parsed);
          void runFetch(parsed);
        }
      } else if (src.startsWith("lz:")) {
        const text = LZString.decompressFromEncodedURIComponent(src.slice(3));
        let files: [string, string][] = [];
        try { files = JSON.parse(text || "[]"); } catch { /* not ours */ }
        if (Array.isArray(files) && files.length) {
          loaded = [];
          for (const [name, body] of files) {
            if (typeof body !== "string") continue;
            if (name) loaded.push({ name, text: body });
            else $src.value = body;
          }
          syncKindLabel();
          renderFiles();
          void runAuditClick();
        }
      }
    });

  },
};

export default tool;
