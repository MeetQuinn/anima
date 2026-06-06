#!/usr/bin/env node
import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const packageDist = join('packages', 'animactl', 'dist');
const packageDocs = join('packages', 'animactl', 'docs');
const packageTemplates = join('packages', 'animactl', 'templates');

await rm(packageDist, { force: true, recursive: true });
await rm(packageDocs, { force: true, recursive: true });
await rm(packageTemplates, { force: true, recursive: true });
await mkdir(packageDist, { recursive: true });

for (const dir of ['server', 'shared', 'web']) {
  await cp(join('dist', dir), join(packageDist, dir), { recursive: true });
}

await cp('templates', packageTemplates, { recursive: true });
await cp('docs', packageDocs, { recursive: true });
await rm(join(packageDocs, '.vitepress'), { force: true, recursive: true });
await rm(join(packageDocs, 'public'), { force: true, recursive: true });
