import { describe, expect, it } from "vitest";
import { redactLogMessage } from "../electron/logger";

describe("desktop log redaction", () => {
  it("hides a one-use workbench token before adding it to the visible ring", () => {
    const line = redactLogMessage("dsh web: http://127.0.0.1:1234/?token=private-launch-token");
    expect(line).toContain("token=[REDACTED]");
    expect(line).not.toContain("private-launch-token");
  });
});
