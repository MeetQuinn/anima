import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const DEV_ANIMA_HOME = '.anima-dev';
const DEV_DASHBOARD_PORT = 14174;
const DEV_TRACK = 'dev';

const configPath = join(process.cwd(), DEV_ANIMA_HOME, 'config.json');

let config = {};
try {
  config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('config root must be an object');
  }
} catch (error) {
  if (!isNotFound(error)) {
    throw new Error(`Unable to read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (config.dashboardPort !== undefined && config.track !== undefined) {
  process.exit(0);
}

await mkdir(dirname(configPath), { recursive: true });
await writeFile(
  configPath,
  `${JSON.stringify({
    ...config,
    dashboardPort: config.dashboardPort ?? DEV_DASHBOARD_PORT,
    track: config.track ?? DEV_TRACK,
  }, null, 2)}\n`,
);

function isNotFound(error) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
