import type { RuntimeChannel } from "../shared/contracts";

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: { label: "alpha" | "beta" | "rc"; number: number };
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/;

export function isSafeVersion(value: string): boolean {
  return VERSION_PATTERN.test(value);
}

export function parseVersion(value: string): ParsedVersion | undefined {
  const match = VERSION_PATTERN.exec(value);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]
      ? {
          label: match[4] as "alpha" | "beta" | "rc",
          number: Number(match[5])
        }
      : undefined
  };
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error(`无法比较版本：${left} / ${right}`);

  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }

  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;

  const weights = { alpha: 0, beta: 1, rc: 2 } as const;
  if (weights[a.prerelease.label] !== weights[b.prerelease.label]) {
    return weights[a.prerelease.label] > weights[b.prerelease.label] ? 1 : -1;
  }
  return Math.sign(a.prerelease.number - b.prerelease.number);
}

export function selectChannelVersion(
  distTags: Record<string, string>,
  channel: RuntimeChannel
): string {
  const version = channel === "preview" ? distTags.alpha ?? distTags.next : distTags.latest;
  if (!version || !isSafeVersion(version)) {
    throw new Error(`注册表没有可用的 ${channel} 版本`);
  }
  return version;
}
