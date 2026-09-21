import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class AtomicJsonStore<T> {
  constructor(
    private readonly filePath: string,
    private readonly fallback: () => T,
    private readonly validate: (value: unknown) => value is T
  ) {}

  async read(): Promise<T> {
    const backupPath = `${this.filePath}.bak`;
    for (const candidate of [this.filePath, backupPath]) {
      try {
        const value: unknown = JSON.parse(await readFile(candidate, "utf8"));
        if (this.validate(value)) return value;
      } catch {
        // Try the backup, then the safe default.
      }
    }
    const value = this.fallback();
    await this.write(value);
    return value;
  }

  async write(value: T): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const backup = `${this.filePath}.bak`;
    const serialized = `${JSON.stringify(value, null, 2)}\n`;

    try {
      await copyFile(this.filePath, backup);
    } catch {
      // No previous state yet.
    }

    await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx" });
    await rename(temporary, this.filePath);
  }
}
