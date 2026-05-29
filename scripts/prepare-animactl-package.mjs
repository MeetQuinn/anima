#!/usr/bin/env node
import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const packageDist = join('packages', 'animactl', 'dist');

await rm(packageDist, { force: true, recursive: true });
await mkdir(packageDist, { recursive: true });

for (const dir of ['server', 'shared', 'web']) {
  await cp(join('dist', dir), join(packageDist, dir), { recursive: true });
}

await cp('templates', join('packages', 'animactl', 'templates'), { recursive: true });
