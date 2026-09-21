import { describe, expect, it } from "vitest";
import {
  ToolResultPruner,
  resolveConfig
} from "@deepseek-ai/dsh-compaction-tool-result-pruner";

const pruner = Object.create(ToolResultPruner.prototype) as ToolResultPruner;
Object.defineProperty(pruner, "config", {
  value: resolveConfig({ thresholdChars: 8192, headChars: 4096, tailChars: 1024 })
});

describe("official DSH tool-result pruning", () => {
  it("keeps short results untouched", () => {
    expect(pruner.pruneContent([{ type: "text", text: "OK" }])).toBeNull();
  });

  it("reduces a long repetitive result while preserving both ends", () => {
    const original = "HEAD\n" + "filler data\n".repeat(2_000) + "TAIL";
    const output = pruner.pruneContent([{ type: "text", text: original }]);
    expect(output).not.toBeNull();
    const reduced = output!.filter((block) => block.type === "text").map((block) => block.text).join("");
    expect(reduced.startsWith("HEAD\n")).toBe(true);
    expect(reduced.endsWith("TAIL")).toBe(true);
    expect(reduced).toContain("tool result middle pruned");
    expect(reduced.length).toBeLessThan(original.length * 0.3);
  });
});
