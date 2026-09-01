/** Minimal semver parsing and unique id generation. No external deps. */

export interface EditionStruct {
  major: number;
  minor: number;
  patch: number;
}

/** Parse "major.minor.patch"; returns null for malformed input. */
export function parseEdition(raw: string): EditionStruct | null {
  const match = raw.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** True when a >= b. */
export function editionGte(a: EditionStruct, b: EditionStruct): boolean {
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch >= b.patch;
}

/** True when pluginEdition satisfies the host's minimum required edition. */
export function checkHostEditionRequirement(pluginEdition: string, hostMinEdition: string): boolean {
  const plugin = parseEdition(pluginEdition);
  const hostMin = parseEdition(hostMinEdition);
  if (!plugin || !hostMin) return false;
  return editionGte(plugin, hostMin);
}

const ID_RANDOM_CHARS = 10;

/** Generate a unique trace/instance mark. */
export function makeUniqueMark(): string {
  const randomFragment = Math.random().toString(36).slice(2, 2 + ID_RANDOM_CHARS);
  return `${Date.now()}-${randomFragment}`;
}

/**
 * Kernel version, mirrored from package.json. Used as the `kernelVersion`
 * field of the run-version fingerprint so config-drift detection can tell a
 * trace recorded under a different release apart from a digest drift.
 * Keep in sync with package.json#version when cutting a release.
 */
export const KERNEL_VERSION = "0.7.0";
