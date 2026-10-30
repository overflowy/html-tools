// Turns a file (name plus text) into a ParsedLockfile, or a LockfileError that says why not.
import { parseBunLock, parseJsonc } from "./bun";
import { KIND_FILENAME, LockfileError, detectKind } from "./lockfiles";
import type { LockfileKind, ParsedLockfile } from "./lockfiles";
import { parsePackageLock } from "./npm";
import { parsePnpmLock } from "./pnpm";
import { parseUvLock } from "./uv";
import { parseYaml } from "./yaml";
import { parseYarnLock } from "./yarn";

export const parseKind = (kind: LockfileKind, text: string): ParsedLockfile => {
  try {
    switch (kind) {
      case "package-lock": {
        return parsePackageLock(parseJsonc(text));
      }
      case "yarn": {
        return parseYarnLock(text);
      }
      case "pnpm": {
        return parsePnpmLock(parseYaml(text));
      }
      case "bun": {
        return parseBunLock(text);
      }
      case "uv": {
        return parseUvLock(text);
      }
      default: {
        throw new LockfileError(`Unknown lockfile kind ${String(kind)}.`);
      }
    }
  } catch (error) {
    if (error instanceof LockfileError) {
      throw error;
    }
    throw new LockfileError(
      `Could not read this ${KIND_FILENAME[kind]}: ${(error as Error).message}`
    );
  }
};

export const parseLockfile = (text: string, filename = ""): ParsedLockfile => {
  const detected = detectKind(text, filename);
  if (detected.kind === null) {
    throw new LockfileError(detected.refusal);
  }
  return parseKind(detected.kind, text);
};
