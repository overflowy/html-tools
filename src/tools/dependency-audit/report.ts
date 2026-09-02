// The Audit as Markdown, for pasting into an issue or pull request.
import type { AuditResult, AuditedPackage, LockfileReport } from "./audit";
import { REASON_LABEL } from "./lockfiles";
import type { Advisory } from "./osv";

export function plural(n: number, word: string): string {
  if (n === 1) return n + " " + word;
  return n + " " + (word.endsWith("y") ? word.slice(0, -1) + "ies" : word + "s");
}

export function severityText(a: Advisory): string {
  const band = a.severity.band === "unknown" ? "unknown severity" : a.severity.band;
  return a.severity.score !== null ? band + " " + a.severity.score.toFixed(1) : band;
}

export function osvUrl(id: string): string {
  return "https://osv.dev/vulnerability/" + encodeURIComponent(id);
}

export function packageTags(p: AuditedPackage["pkg"]): string[] {
  const tags: string[] = [];
  if (p.direct === true) tags.push("direct");
  else if (p.direct === false) tags.push("transitive");
  tags.push(...p.groups);
  return tags;
}

function packageMarkdown(ap: AuditedPackage): string {
  const tags = packageTags(ap.pkg);
  const worst = ap.hits[0]!.advisory;
  const lines = ["### " + ap.pkg.name + "@" + ap.pkg.version + (tags.length ? " · " + tags.join(", ") : "") + " · " + severityText(worst)];
  for (const { advisory, fix } of ap.hits) {
    const ids = [advisory.id, ...advisory.aliases].join(", ");
    const fixText = fix.fixed ? "Fixed in " + fix.fixed + "." : fix.unfixed ? "No fixed version." : "";
    lines.push("- [" + advisory.id + "](" + osvUrl(advisory.id) + ")" + (advisory.aliases.length ? " (" + ids.slice(advisory.id.length + 2) + ")" : "") +
      " · " + severityText(advisory) + (advisory.summary ? ": " + advisory.summary.replace(/\s+/g, " ") : "") + (fixText ? " " + fixText : ""));
  }
  return lines.join("\n");
}

function lockfileMarkdown(r: LockfileReport): string {
  if (!r.parsed) return "## " + r.name + "\n\nCould not be read: " + r.error;
  const affected = r.packages.filter((p) => p.hits.length);
  const hits = affected.reduce((n, p) => n + p.hits.length, 0);
  const lines = ["## " + r.name + " (" + r.parsed.label + ", " + r.parsed.ecosystem + ")", "",
    plural(r.parsed.packages.length, "package") + " checked, " + plural(hits, "advisory hit") + " in " + plural(affected.length, "package") +
    (r.parsed.notChecked.length ? ", " + r.parsed.notChecked.length + " not checked" : "") + "."];
  if (!r.parsed.knowsDirect) lines.push("", "This lockfile does not record which packages are direct dependencies.");
  for (const ap of affected) lines.push("", packageMarkdown(ap));
  if (r.parsed.notChecked.length) {
    lines.push("", "Not checked: " + r.parsed.notChecked.map((n) => n.name + (n.version ? "@" + n.version : "") + " (" + REASON_LABEL[n.reason] + ")").join(", ") + ".");
  }
  return lines.join("\n");
}

export function reportMarkdown(result: AuditResult, sourceLabel: string | null): string {
  const packages = result.lockfiles.reduce((n, r) => n + (r.parsed?.packages.length ?? 0), 0);
  const affected = result.lockfiles.reduce((n, r) => n + r.packages.filter((p) => p.hits.length).length, 0);
  const head = ["# Dependency audit" + (sourceLabel ? " of " + sourceLabel : ""), "",
    plural(result.advisories.length, "advisory") + " across " + plural(affected, "package") + ", out of " + plural(packages, "package") +
    " in " + plural(result.lockfiles.length, "lockfile") + ". Source: [OSV.dev](https://osv.dev), " + new Date().toISOString().slice(0, 10) + "."];
  if (result.failedRecords.length) head.push("", "Details could not be fetched for: " + result.failedRecords.join(", ") + ".");
  return head.join("\n") + "\n\n" + result.lockfiles.map(lockfileMarkdown).join("\n\n") + "\n";
}
