import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { z } from 'zod';
import { withFileLock } from '../storage/lock.js';
import { safeFilename } from '../storage/safe-filename.js';
import type { LinearIdentityService } from './identity.service.js';

const TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/markdown',
  '.json': 'application/json', '.csv': 'text/csv',
};
const Upload = z.object({ fileUpload: z.object({ success: z.literal(true), uploadFile: z.object({
  uploadUrl: z.string().url().refine((value) => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }),
  // Only permanent private asset links belong in reply bodies and their audit.
  assetUrl: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.origin === 'https://uploads.linear.app' && !url.username && !url.password && !url.search && !url.hash;
  }),
  headers: z.array(z.object({ key: z.string(), value: z.string() })),
}) }) });

export type LinearReplyFile = { name: string; blob: Blob; digest: string };

/** Read every file before any remote effect; the Blob rejects subsequent file changes. */
export async function prepareLinearReplyFiles(paths: string[]): Promise<LinearReplyFile[]> {
  const files: LinearReplyFile[] = [];
  for (const path of paths) {
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0 || info.size > 2_147_483_647) throw new Error('Linear attachments must be nonempty regular files smaller than 2 GiB.');
    const name = safeFilename(basename(path));
    const blob = await openAsBlob(path, { type: TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream' });
    const hash = createHash('sha256');
    for await (const chunk of blob.stream()) hash.update(chunk);
    files.push({ name, blob, digest: hash.digest('hex') });
  }
  return files;
}

function label(name: string): string {
  return name.replace(/[\r\n]/g, ' ').replace(/[\\`*_[\]<>!]/g, '\\$&');
}

export function linearReplyWithFiles(body: string, files: { name: string; url: string; image: boolean }[]): string {
  return [body, ...files.map((file) => `${file.image ? '!' : ''}[${label(file.name)}](<${file.url}>)`)].filter(Boolean).join('\n\n');
}

export class LinearReplyFilesService {
  constructor(readonly identity: LinearIdentityService) {}

  async upload(files: LinearReplyFile[]): Promise<{ name: string; url: string; image: boolean }[]> {
    const { id: installationId } = await this.identity.authorizedInstallation();
    const uploaded: { name: string; url: string; image: boolean }[] = [];
    for (const file of files) {
      const key = createHash('sha256').update(JSON.stringify([file.name, file.digest])).digest('hex');
      const home = this.identity.store.animaHome;
      const url = await withFileLock(join(home, 'agents', this.identity.agentId, `linear-upload-${key}`), home, async () => {
        const install = await this.identity.authorizedInstallation(installationId);
        if (install.uploadedFiles?.[key]) return install.uploadedFiles[key];
        const result = await this.identity.graphql(installationId,
          'mutation($contentType:String!,$filename:String!,$size:Int!){fileUpload(contentType:$contentType,filename:$filename,size:$size){success uploadFile{uploadUrl assetUrl headers{key value}}}}',
          { contentType: file.blob.type, filename: file.name, size: file.blob.size }, Upload);
        const upload = result.fileUpload.uploadFile;
        await this.identity.authorizedInstallation(installationId);
        await this.identity.client.uploadFile(upload.uploadUrl, upload.headers, file.blob);
        await this.identity.authorizedInstallation(installationId);
        await this.identity.store.update((state) => {
          if (state.installation?.id !== installationId || state.installation.revoked) throw new Error('Linear identity changed during upload. No reply was posted.');
          return { ...state, installation: { ...state.installation, uploadedFiles: { ...state.installation.uploadedFiles, [key]: upload.assetUrl } } };
        });
        return upload.assetUrl;
      });
      uploaded.push({ name: file.name, url, image: file.blob.type.startsWith('image/') });
    }
    await this.identity.authorizedInstallation(installationId);
    return uploaded;
  }
}
