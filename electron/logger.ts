import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function redactLogMessage(message: string): string {
  return message
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/(api[_-]?key|authorization|token)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .trim();
}

export class FileRingLogger {
  private readonly ring: string[] = [];

  constructor(
    readonly filePath: string,
    private readonly capacity = 240
  ) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const info = await stat(this.filePath);
      if (info.size > MAX_FILE_BYTES) {
        await writeFile(this.filePath, "", "utf8");
      }
    } catch {
      await writeFile(this.filePath, "", "utf8");
    }
  }

  log(scope: string, message: string): void {
    const sanitized = redactLogMessage(message);
    if (!sanitized) return;
    const line = `${new Date().toISOString()} [${scope}] ${sanitized}`;
    this.ring.push(line);
    if (this.ring.length > this.capacity) this.ring.shift();
    void appendFile(this.filePath, `${line}\n`, "utf8");
  }

  recent(): string[] {
    return [...this.ring];
  }
}
