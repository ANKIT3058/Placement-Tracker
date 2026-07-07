// Storage abstraction for attachment bytes. Workers depend on this interface
// only — never on a concrete filesystem/S3 implementation — so the storage
// backend can be swapped (local disk today, S3/GCS later) without touching
// the worker or service code.
export interface StorageService {
  /**
   * Persist raw bytes and return an opaque storage path/key that can later be
   * passed to `read` / `delete`. The `key` is a caller-provided logical path
   * (e.g. "attachments/<id>/<filename>").
   */
  store(key: string, data: Buffer): Promise<string>;

  /** Read previously stored bytes by the path returned from `store`. */
  read(path: string): Promise<Buffer>;

  /** Remove previously stored bytes. Must be idempotent. */
  delete(path: string): Promise<void>;
}
