import { describe, expect, it } from "vitest";
import { compareVersions, isSafeVersion, selectChannelVersion } from "../electron/versioning";

describe("versioning", () => {
  it("orders alpha, rc and stable versions", () => {
    expect(compareVersions("0.1.6-alpha.2", "0.1.5-rc.2")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0-rc.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.0-rc.2", "1.2.0-rc.1")).toBeGreaterThan(0);
  });

  it("rejects values that could become package-manager arguments", () => {
    expect(isSafeVersion("0.1.5-rc.2")).toBe(true);
    expect(isSafeVersion("latest")).toBe(false);
    expect(isSafeVersion("0.1.5 && whoami")).toBe(false);
  });

  it("keeps preview versions opt-in", () => {
    const tags = { latest: "0.1.5-rc.2", alpha: "0.1.6-alpha.2" };
    expect(selectChannelVersion(tags, "stable")).toBe("0.1.5-rc.2");
    expect(selectChannelVersion(tags, "preview")).toBe("0.1.6-alpha.2");
  });
});
