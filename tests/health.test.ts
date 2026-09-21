import { describe, expect, it } from "vitest";
import { isHealthyHttpStatus } from "../electron/health";

describe("HTTP health classification", () => {
  it("accepts the legacy public index and an authenticated response", () => {
    expect(isHealthyHttpStatus(200)).toBe(true);
    expect(isHealthyHttpStatus(303)).toBe(true);
  });

  it("accepts a protected bare origin without consuming a launch token", () => {
    expect(isHealthyHttpStatus(401)).toBe(true);
  });

  it("rejects other client and server failures", () => {
    expect(isHealthyHttpStatus(403)).toBe(false);
    expect(isHealthyHttpStatus(404)).toBe(false);
    expect(isHealthyHttpStatus(500)).toBe(false);
  });
});
