// The deduplicating Package collector every parser fills in.
import { compareLoose } from "./lockfiles";
import type {
  Ecosystem,
  NotChecked,
  NotCheckedReason,
  Package,
} from "./lockfiles";

/** Builds a package list with duplicates merged: direct wins over transitive, groups union. */
export class PackageSet {
  readonly ecosystem: Ecosystem;
  readonly notChecked: NotChecked[] = [];
  private byKey = new Map<string, Package>();
  private seenNotChecked = new Set<string>();

  constructor(ecosystem: Ecosystem) {
    this.ecosystem = ecosystem;
  }

  add(
    name: string,
    version: string,
    direct: boolean | null,
    groups: string[] = []
  ): Package {
    const key = `${name}@${version}`;
    const existing = this.byKey.get(key);
    if (!existing) {
      const p: Package = {
        direct,
        ecosystem: this.ecosystem,
        groups: [...groups],
        name,
        version,
      };
      this.byKey.set(key, p);
      return p;
    }
    if (direct === true) {
      existing.direct = true;
    } else if (direct === false && existing.direct === null) {
      existing.direct = false;
    }
    for (const g of groups) {
      if (!existing.groups.includes(g)) {
        existing.groups.push(g);
      }
    }
    return existing;
  }

  skip(name: string, version: string, reason: NotCheckedReason, detail = "") {
    const key = `${name}@${version}@${reason}`;
    if (this.seenNotChecked.has(key)) {
      return;
    }
    this.seenNotChecked.add(key);
    this.notChecked.push({ detail, name, reason, version });
  }

  get(name: string, version: string): Package | undefined {
    return this.byKey.get(`${name}@${version}`);
  }

  hasSkipped(name: string): boolean {
    return this.notChecked.some((n) => n.name === name);
  }

  packages(): Package[] {
    return [...this.byKey.values()].toSorted(
      (a, b) =>
        a.name.localeCompare(b.name) || compareLoose(a.version, b.version)
    );
  }
}
