import { promises as fs } from 'fs';
import { dirname, resolve } from 'path';
import os from 'os';
import { UploadSession } from '../types/index.js';

export interface UploadSessionStoreOptions {
  baseDir?: string;
  explicitPath?: string;
  sessionId?: string;
  resumeFrom?: string;
}

interface InitResult {
  session: UploadSession;
  resumed: boolean;
}

export class UploadSessionStore {
  private manifestPath?: string;
  private sessionId?: string;

  constructor(private readonly options: UploadSessionStoreOptions = {}) {}

  async initialize(session: UploadSession): Promise<InitResult> {
    if (this.options.explicitPath) {
      this.manifestPath = resolve(this.options.explicitPath);
    }

    if (this.options.resumeFrom) {
      const loaded = await this.tryLoad(this.options.resumeFrom);
      if (loaded) {
        this.manifestPath = loaded.manifestPath;
        this.sessionId = loaded.session.id;
        return { session: loaded.session, resumed: true };
      }
    }

    if (!this.manifestPath) {
      const baseDir = this.options.baseDir ? resolve(this.options.baseDir) : this.getDefaultBaseDir();
      await fs.mkdir(baseDir, { recursive: true });
      this.sessionId = this.options.sessionId || session.id;
      this.manifestPath = resolve(baseDir, `${this.sessionId}.json`);

      const existing = await this.tryLoad(this.manifestPath);
      if (existing) {
        this.sessionId = existing.session.id;
        return { session: existing.session, resumed: true };
      }
    }

    session.manifestPath = this.manifestPath;
    await this.writeManifest(session);
    return { session, resumed: false };
  }

  async save(session: UploadSession): Promise<void> {
    if (!this.manifestPath) return;
    session.manifestPath = this.manifestPath;
    await this.writeManifest(session);
  }

  getManifestPath(): string | undefined {
    return this.manifestPath;
  }

  private getDefaultBaseDir(): string {
    return resolve(os.homedir(), '.kablewy-cli', 'upload-sessions');
  }

  private async tryLoad(ref: string): Promise<{ session: UploadSession; manifestPath: string } | null> {
    const candidatePath = resolve(ref);
    try {
      const data = await fs.readFile(candidatePath, 'utf8');
      const session = JSON.parse(data) as UploadSession;
      session.manifestPath = candidatePath;
      return { session, manifestPath: candidatePath };
    } catch (error: unknown) {
      if (this.options.baseDir) {
        const byIdPath = resolve(this.options.baseDir, `${ref}.json`);
        try {
          const data = await fs.readFile(byIdPath, 'utf8');
          const session = JSON.parse(data) as UploadSession;
          session.manifestPath = byIdPath;
          return { session, manifestPath: byIdPath };
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  private async writeManifest(session: UploadSession): Promise<void> {
    if (!this.manifestPath) return;
    const tempPath = `${this.manifestPath}.tmp`;
    const payload = JSON.stringify(session, null, 2);
    await fs.mkdir(dirname(this.manifestPath), { recursive: true });
    await fs.writeFile(tempPath, payload, 'utf8');
    await fs.rename(tempPath, this.manifestPath);
  }
}
