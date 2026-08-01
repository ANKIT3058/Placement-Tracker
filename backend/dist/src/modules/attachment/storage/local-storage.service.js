import { promises as fs } from "node:fs";
import path from "node:path";
// Local filesystem implementation of StorageService. All files live under a
// single root directory (configurable via ATTACHMENT_STORAGE_DIR). The returned
// storage path is absolute so downstream sprints can read files back regardless
// of the process working directory.
export class LocalStorageService {
    rootDir;
    constructor(rootDir) {
        this.rootDir =
            rootDir ??
                process.env.ATTACHMENT_STORAGE_DIR ??
                path.resolve(process.cwd(), "storage", "attachments");
    }
    resolve(key) {
        // Guard against path traversal in keys ("../"): resolve and confirm the
        // result stays inside the root directory.
        const target = path.resolve(this.rootDir, key);
        const relative = path.relative(this.rootDir, target);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
            throw new Error(`Invalid storage key: ${key}`);
        }
        return target;
    }
    async store(key, data) {
        const target = this.resolve(key);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, data);
        return target;
    }
    async read(storagePath) {
        return fs.readFile(storagePath);
    }
    async delete(storagePath) {
        await fs.rm(storagePath, { force: true });
    }
}
// Shared singleton used across the attachment module. Swap this line for a
// future S3StorageService without changing any worker/service code.
export const storageService = new LocalStorageService();
//# sourceMappingURL=local-storage.service.js.map