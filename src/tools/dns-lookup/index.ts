import "./tool.css";
import type { Tool } from "../../shell/types";
import {
  COMMON_TYPES, LookupError, RESOLVERS, SUBDOMAIN_SOURCES, TYPE_GROUPS, formatTtl, lookup, mergeSubdomains,
  normalizeName, outcomeOf, pool, rcodeName, resolverById, reverseName, subdomainSearchName, typeName, validCustomType,
  type DnsRecord, type DnsResponse, type LookupResult, type QueryOptions, type Resolver, type SubdomainHit,
} from "./dns";

type Action = "lookup" | "all" | "subs";
const ACTIONS = new Set<string>(["lookup", "all", "subs"]);

/** Lookups in flight at once during All Types. */
const CONCURRENCY = 4;

const PICKER_TYPES = new Set(TYPE_GROUPS.flatMap((g) => g.types));

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function plural(n: number, word: string): string {
  return n + " " + word + (n === 1 ? "" : "s");
}

function flagsHtml(r: DnsResponse): string {
  const status = '<span class="flag status ' + (r.Status === 0 ? "on" : "bad") + '">' + esc(rcodeName(r.Status)) + "</span>";
  const bits = (["RD", "RA", "AD", "CD", "TC"] as const)
    .map((f) => '<span class="flag ' + (r[f] ? "on" : "off") + '" title="' + f + '">' + f + "</span>")
    .join("");
  return status + bits;
}

function tableHtml(records: DnsRecord[]): string {
  const rows = records.map((rec) =>
    "<tr><td class=\"c-name\">" + esc(rec.name) + "</td>" +
    '<td class="c-type"><span class="type-badge">' + esc(typeName(rec.type)) + "</span></td>" +
    '<td class="c-ttl" title="' + rec.TTL + ' seconds">' + esc(formatTtl(rec.TTL)) + "</td>" +
    '<td class="c-data">' + esc(rec.data) + "</td></tr>");
  return '<table class="records"><thead><tr><th>name</th><th>type</th><th>ttl</th><th>data</th></tr></thead><tbody>' +
    rows.join("") + "</tbody></table>";
}

function commentsHtml(r: DnsResponse): string {
  return r.Comment.map((c) => '<p class="comment">' + esc(c) + "</p>").join("");
}

/** The records pane body for one Response: answer, or why there is none, plus any authority section. */
function responseHtml(name: string, type: string, r: DnsResponse, withAuthority: boolean): string {
  let html = "";
  switch (outcomeOf(r)) {
    case "records":
      html += tableHtml(r.Answer);
      break;
    case "empty":
      html += '<p class="note">No ' + esc(type) + " records for " + esc(name) + ".</p>";
      break;
    case "nxdomain":
      html += '<p class="note">' + esc(name) + " does not exist (NXDOMAIN).</p>";
      break;
    case "failed":
      html += '<div class="error-box">The resolver answered ' + esc(rcodeName(r.Status)) +
        (r.Comment.length ? ": " + esc(r.Comment.join("; ")) : ".") + "</div>";
      return html;
  }
  if (withAuthority && r.Authority.length) html += '<h3 class="section">authority</h3>' + tableHtml(r.Authority);
  html += commentsHtml(r);
  return html;
}

const tool: Tool = {
  id: "dns-lookup",
  name: "DNS Lookup",
  subtitle: "Query DNS records through Cloudflare or Google DNS-over-HTTPS, and list subdomains from certificate logs.",
  keywords: ["dns", "lookup", "dig", "nslookup", "domain", "records", "mx", "txt", "cname", "nameserver", "ns", "subdomains", "reverse", "ptr", "doh", "dnssec", "resolver", "ip"],
  mount(el, ctx) {
    const typeOptions = TYPE_GROUPS.map((g) =>
      '<optgroup label="' + g.label + '">' + g.types.map((t) => '<option value="' + t + '">' + t + "</option>").join("") + "</optgroup>").join("");
    const resolverOptions = RESOLVERS.map((r) => '<option value="' + r.id + '">' + esc(r.label) + "</option>").join("");

    el.innerHTML = `
      <div class="query">
        <input type="text" class="name" placeholder="example.com, https://example.com/page, or 8.8.8.8"
          spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Name">
        <select class="type" aria-label="Record type">${typeOptions}<option value="custom">Custom…</option></select>
        <input type="text" class="custom-type" placeholder="type or number" aria-label="Custom record type"
          spellcheck="false" autocapitalize="off" autocomplete="off" hidden>
        <div class="actions">
          <button class="btn-lookup primary" type="button">Lookup</button>
          <button class="btn-all" type="button">All types</button>
          <button class="btn-subs" type="button">Subdomains</button>
        </div>
      </div>
      <div class="options">
        <label class="opt">resolver <select class="resolver">${resolverOptions}</select></label>
        <label class="opt"><input type="checkbox" class="opt-cd"> checking disabled (CD)</label>
        <label class="opt"><input type="checkbox" class="opt-do"> DNSSEC OK (DO)</label>
      </div>
      <div class="panes">
        <section class="pane">
          <div class="pane-head"><span class="results-title">records</span><span class="spacer"></span><span class="flags"></span></div>
          <div class="results"><p class="note">Enter a name and press Lookup.</p></div>
          <div class="statusbar"><span class="dot">&#9679;</span><span class="status-text">Waiting for a query</span></div>
        </section>
        <section class="pane">
          <div class="pane-head"><span>raw response</span><span class="spacer"></span><button class="btn-copy primary" type="button">Copy</button></div>
          <pre class="raw"></pre>
        </section>
      </div>`;

    const $ = (sel: string) => el.querySelector(sel) as HTMLElement;
    const $name = $(".name") as HTMLInputElement;
    const $type = $(".type") as HTMLSelectElement;
    const $custom = $(".custom-type") as HTMLInputElement;
    const $resolver = $(".resolver") as HTMLSelectElement;
    const $cd = $(".opt-cd") as HTMLInputElement;
    const $do = $(".opt-do") as HTMLInputElement;
    const $results = $(".results");
    const $resultsTitle = $(".results-title");
    const $flags = $(".flags");
    const $status = $(".statusbar");
    const $statusText = $(".status-text");
    const $raw = $(".raw");
    const $btnCopy = $(".btn-copy") as HTMLButtonElement;
    const buttons = [...el.querySelectorAll(".actions button")] as HTMLButtonElement[];

    function setStatus(kind: string, msg: string) {
      $status.className = "statusbar " + kind;
      $statusText.textContent = msg;
    }

    function showRaw(value: unknown) {
      $raw.textContent = value === undefined ? "" : JSON.stringify(value, null, 2);
    }

    function currentType(): string | null {
      if ($type.value !== "custom") return $type.value;
      return validCustomType($custom.value);
    }

    function currentOptions(): QueryOptions {
      return { cd: $cd.checked, do: $do.checked };
    }

    /** The last query that ran; what the Deep Link reproduces. */
    let last: { resolver: string; opts: QueryOptions; action: Action; type: string; name: string } | null = null;

    /** State layout: `<resolver>.<cd><do>.<action>.<type>.<name, URI-encoded>`. */
    function publishState() {
      if (!last) return;
      const flags = (last.opts.cd ? "1" : "0") + (last.opts.do ? "1" : "0");
      ctx.setState([last.resolver, flags, last.action, last.type, encodeURIComponent(last.name)].join("."));
    }

    let inflight: AbortController | null = null;

    /** Abort whatever is running and start a new run; returns the controller to check against. */
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
      const msg = e instanceof LookupError || e instanceof Error ? e.message : String(e);
      $results.innerHTML = '<div class="error-box">' + esc(msg) + "</div>";
      $flags.innerHTML = "";
      showRaw(undefined);
      setStatus("error", msg);
    }

    /** Validate the input and, if usable, record it as the last query. Returns null after showing the problem. */
    function prepare(action: Action): { name: string; type: string; resolver: Resolver; opts: QueryOptions } | null {
      const name = normalizeName($name.value);
      if (!name) {
        setStatus("error", "Enter a domain name or IP address.");
        $name.focus();
        return null;
      }
      const type = currentType();
      if (type === null) {
        setStatus("error", "Enter a record type name or number, e.g. TLSA or 65.");
        $custom.focus();
        return null;
      }
      const resolver = resolverById($resolver.value);
      const opts = currentOptions();
      $name.value = name;
      last = { resolver: resolver.id, opts, action, type, name };
      publishState();
      return { name, type, resolver, opts };
    }

    async function runLookup() {
      const q = prepare("lookup");
      if (!q) return;
      const ctrl = begin();
      const arpa = reverseName(q.name);
      const qname = arpa ?? q.name;
      const qtype = arpa ? "PTR" : q.type;
      $resultsTitle.textContent = arpa ? "reverse lookup" : "records";
      setStatus("", "Querying " + qname + " " + qtype + " via " + q.resolver.label + "…");
      try {
        const { response, ms } = await lookup(q.resolver, qname, qtype, q.opts, ctrl.signal);
        if (ctrl.signal.aborted) return;
        $results.innerHTML = responseHtml(qname, qtype, response, true);
        $flags.innerHTML = flagsHtml(response);
        showRaw(response);
        const n = response.Answer.length;
        setStatus(outcomeOf(response) === "failed" ? "error" : "ok",
          (n ? plural(n, "record") : outcomeOf(response) === "nxdomain" ? "NXDOMAIN" : "no records") +
          " · " + ms + " ms · " + q.resolver.label);
      } catch (e) {
        fail(ctrl, e);
      } finally {
        finish(ctrl);
      }
    }

    async function runAll() {
      const q = prepare("all");
      if (!q) return;
      if (reverseName(q.name)) {
        // Every type of an arpa name is noise; an address only has its PTR.
        await runLookup();
        return;
      }
      const ctrl = begin();
      $resultsTitle.textContent = "all types";
      $flags.innerHTML = "";
      $results.innerHTML = '<div class="groups">' + COMMON_TYPES.map((t) =>
        '<details class="group" data-type="' + t + '"><summary><span class="type-badge">' + t +
        '</span><span class="count">…</span><span class="spacer"></span><span class="group-flags"></span></summary><div class="group-body"></div></details>').join("") + "</div>";
      showRaw(undefined);
      const started = performance.now();
      const raw: Record<string, DnsResponse | { error: string }> = {};
      let done = 0;
      let total = 0;
      setStatus("", "Querying " + q.name + " for " + COMMON_TYPES.length + " types via " + q.resolver.label + "… 0/" + COMMON_TYPES.length);
      try {
        await pool(COMMON_TYPES, CONCURRENCY, async (type) => {
          const group = $results.querySelector('.group[data-type="' + type + '"]') as HTMLDetailsElement;
          const $count = group.querySelector(".count") as HTMLElement;
          const $body = group.querySelector(".group-body") as HTMLElement;
          let result: LookupResult | null = null;
          try {
            result = await lookup(q.resolver, q.name, type, q.opts, ctrl.signal);
          } catch (e) {
            if (ctrl.signal.aborted) return;
            const msg = (e as Error).message;
            raw[type] = { error: msg };
            group.open = true;
            group.classList.add("failed");
            $count.textContent = "failed";
            $body.innerHTML = '<div class="error-box">' + esc(msg) + "</div>";
          }
          if (ctrl.signal.aborted) return;
          if (result) {
            const r = result.response;
            raw[type] = r;
            const outcome = outcomeOf(r);
            total += r.Answer.length;
            group.open = outcome === "records" || outcome === "failed";
            group.classList.toggle("empty", outcome !== "records");
            group.classList.toggle("failed", outcome === "failed");
            $count.textContent = outcome === "records" ? plural(r.Answer.length, "record") : outcome === "empty" ? "none" : rcodeName(r.Status);
            (group.querySelector(".group-flags") as HTMLElement).innerHTML = flagsHtml(r);
            $body.innerHTML = responseHtml(q.name, type, r, false);
          }
          done++;
          setStatus("", "Querying " + q.name + " for " + COMMON_TYPES.length + " types via " + q.resolver.label + "… " + done + "/" + COMMON_TYPES.length);
        });
        if (ctrl.signal.aborted) return;
        showRaw(raw);
        const failed = Object.values(raw).filter((r) => "error" in r).length;
        setStatus(failed ? "error" : "ok",
          COMMON_TYPES.length + " types · " + plural(total, "record") + (failed ? " · " + plural(failed, "failure") : "") +
          " · " + Math.round(performance.now() - started) + " ms · " + q.resolver.label);
      } catch (e) {
        fail(ctrl, e);
      } finally {
        finish(ctrl);
      }
    }

    function subdomainsHtml(hits: SubdomainHit[], errors: { label: string; message: string }[]): string {
      let html = errors.map((e) => '<div class="error-box">' + esc(e.label) + ": " + esc(e.message) + "</div>").join("");
      if (!hits.length) {
        html += '<p class="note">' + (errors.length ? "No subdomains from the sources that answered." : "No subdomains found.") + "</p>";
        return html;
      }
      html += '<table class="records subs"><thead><tr><th>name</th><th>ip</th><th>source</th></tr></thead><tbody>' +
        hits.map((h) =>
          '<tr><td class="c-name"><button type="button" class="link" data-name="' + esc(h.name) + '" title="Look up ' + esc(h.name) + '">' + esc(h.name) + "</button></td>" +
          '<td class="c-ip">' + esc(h.ip) + "</td>" +
          '<td class="c-source">' + esc(h.sources.join(", ")) + "</td></tr>").join("") +
        "</tbody></table>";
      return html;
    }

    async function runSubdomains() {
      const q = prepare("subs");
      if (!q) return;
      if (reverseName(q.name)) {
        setStatus("error", "Subdomain search needs a domain name, not an IP address.");
        return;
      }
      const ctrl = begin();
      const name = subdomainSearchName(q.name);
      $resultsTitle.textContent = "subdomains of " + name;
      $flags.innerHTML = "";
      $results.innerHTML = "";
      showRaw(undefined);
      setStatus("", "Searching " + SUBDOMAIN_SOURCES.map((s) => s.label).join(" and ") + " for " + name + "…");
      const started = performance.now();
      try {
        const settled = await Promise.all(SUBDOMAIN_SOURCES.map(async (source) => {
          try {
            return { source, hosts: await source.fetch(name, ctrl.signal), error: "" };
          } catch (e) {
            if (ctrl.signal.aborted) throw e;
            return { source, hosts: [], error: (e as Error).message };
          }
        }));
        if (ctrl.signal.aborted) return;
        const errors = settled.filter((s) => s.error).map((s) => ({ label: s.source.label, message: s.error }));
        const hits = mergeSubdomains(name, settled.filter((s) => !s.error));
        $results.innerHTML = subdomainsHtml(hits, errors);
        showRaw(Object.fromEntries(settled.map((s) => [s.source.label, s.error ? { error: s.error } : s.hosts])));
        const perSource = settled.map((s) => s.source.label + " " + (s.error ? "failed" : s.hosts.length)).join(" · ");
        setStatus(errors.length === settled.length ? "error" : "ok",
          plural(hits.length, "subdomain") + " · " + perSource + " · " + Math.round(performance.now() - started) + " ms");
      } catch (e) {
        fail(ctrl, e);
      } finally {
        finish(ctrl);
      }
    }

    function run(action: Action) {
      if (action === "all") void runAll();
      else if (action === "subs") void runSubdomains();
      else void runLookup();
    }

    function syncCustom() {
      $custom.hidden = $type.value !== "custom";
    }

    ctx.onRestore((payload) => {
      const [resolver, flags, action, type, ...rest] = payload.split(".");
      const name = (() => {
        try { return decodeURIComponent(rest.join(".")); } catch { return ""; }
      })();
      if (RESOLVERS.some((r) => r.id === resolver)) $resolver.value = resolver!;
      if (/^[01]{2}$/.test(flags ?? "")) {
        $cd.checked = flags![0] === "1";
        $do.checked = flags![1] === "1";
      }
      if (type && PICKER_TYPES.has(type)) {
        $type.value = type;
      } else if (type && validCustomType(type)) {
        $type.value = "custom";
        $custom.value = type;
      }
      syncCustom();
      if (name) {
        $name.value = name;
        run(action && ACTIONS.has(action) ? (action as Action) : "lookup");
      }
    });

    $type.addEventListener("change", () => {
      syncCustom();
      if ($type.value === "custom") $custom.focus();
    });
    $name.addEventListener("keydown", (e) => { if (e.key === "Enter") run("lookup"); });
    $custom.addEventListener("keydown", (e) => { if (e.key === "Enter") run("lookup"); });
    $(".btn-lookup").addEventListener("click", () => run("lookup"));
    $(".btn-all").addEventListener("click", () => run("all"));
    $(".btn-subs").addEventListener("click", () => run("subs"));

    // A subdomain row is a shortcut to looking that name up.
    $results.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("button.link") as HTMLButtonElement | null;
      if (!btn || !btn.dataset.name) return;
      $name.value = btn.dataset.name;
      run("lookup");
    });

    $btnCopy.addEventListener("click", () => {
      if (!$raw.textContent) return;
      navigator.clipboard.writeText($raw.textContent).then(() => {
        const old = $btnCopy.textContent;
        $btnCopy.textContent = "Copied";
        setTimeout(() => { $btnCopy.textContent = old; }, 1200);
      });
    });
  },
};

export default tool;
