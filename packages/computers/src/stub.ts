import { ProviderError } from "./contract.ts";
import type {
  ActivityLease,
  ComputerProvider,
  ComputerRef,
  ComputerStatus,
  ExecOptions,
  ExecResult,
  FileEntry,
  ProvisionOptions,
} from "./contract.ts";

interface StubBox {
  ref: ComputerRef;
  state: ComputerStatus["state"];
  files: Map<string, Uint8Array>;
  createdAt: string;
}

/**
 * An in-memory provider so the product, the allocator and the UI can be built
 * and tested without an account anywhere. It owns no real machine: exec records
 * nothing, the file map is process-local, and a screenshot is a 1x1 PNG.
 */
export class StubComputerProvider implements ComputerProvider {
  readonly name = "stub";
  readonly account = "stub";
  #boxes = new Map<string, StubBox>();
  #counter = 0;

  async provision(_options: ProvisionOptions = {}): Promise<ComputerRef> {
    this.#counter += 1;
    const ref: ComputerRef = { provider: this.name, account: this.account, id: `stub-${this.#counter}` };
    this.#boxes.set(ref.id, {
      ref,
      state: "running",
      files: new Map([["/home/bot/README.md", new TextEncoder().encode("stub computer")]]),
      createdAt: new Date().toISOString(),
    });
    return ref;
  }

  async start(ref: ComputerRef): Promise<ComputerStatus> {
    const box = this.#require(ref);
    box.state = "running";
    return this.status(ref);
  }

  async sleep(ref: ComputerRef): Promise<ComputerStatus> {
    const box = this.#boxes.get(ref.id);
    if (box && box.state === "running") box.state = "sleeping";
    return this.status(ref);
  }

  async destroy(ref: ComputerRef): Promise<void> {
    this.#boxes.delete(ref.id);
  }

  async exec(ref: ComputerRef, _command: string, options?: ExecOptions): Promise<ExecResult> {
    this.#require(ref);
    options?.onOutput?.("stdout", "");
    return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
  }

  async putFile(ref: ComputerRef, path: string, data: Uint8Array | string): Promise<void> {
    const box = this.#require(ref);
    box.files.set(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
  }

  async getFile(ref: ComputerRef, path: string): Promise<Uint8Array> {
    const box = this.#require(ref);
    const file = box.files.get(path);
    if (!file) throw new ProviderError("not_found", `no file at ${path}`);
    return file;
  }

  async list(ref: ComputerRef, path: string): Promise<FileEntry[]> {
    const box = this.#require(ref);
    const prefix = path.endsWith("/") ? path : `${path}/`;
    return [...box.files.entries()]
      .filter(([filePath]) => filePath.startsWith(prefix))
      .map(([filePath, data]) => ({
        name: filePath.slice(prefix.length),
        path: filePath,
        type: "file" as const,
        size: data.byteLength,
      }));
  }

  async screenshot(ref: ComputerRef): Promise<{ png: Uint8Array; takenAt: string }> {
    this.#require(ref);
    const png = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    return { png, takenAt: new Date().toISOString() };
  }

  async status(ref: ComputerRef): Promise<ComputerStatus> {
    const box = this.#require(ref);
    return {
      state: box.state,
      ready: box.state === "running",
      createdAt: box.createdAt,
      processesPreserved: true,
    };
  }

  async lease(ref: ComputerRef, leaseId: string, ttlSeconds = 60): Promise<ActivityLease> {
    this.#require(ref);
    return { id: leaseId, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
  }

  async releaseLease(_ref: ComputerRef, _leaseId: string): Promise<void> {}

  async listComputers(): Promise<Array<ComputerRef & { name: string; status: ComputerStatus }>> {
    return [...this.#boxes.values()].map((box) => ({
      ...box.ref,
      name: box.ref.id,
      status: {
        state: box.state,
        ready: box.state === "running",
        createdAt: box.createdAt,
      } satisfies ComputerStatus,
    }));
  }

  #require(ref: ComputerRef): StubBox {
    const box = this.#boxes.get(ref.id);
    if (!box) throw new ProviderError("not_found", `no computer ${ref.id}`);
    return box;
  }
}
