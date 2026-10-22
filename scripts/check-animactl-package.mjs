#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverPackagePath = join(repoRoot, "server", "package.json");
const animactlPackageDir = join(repoRoot, "packages", "animactl");
const animactlPackagePath = join(animactlPackageDir, "package.json");

const shouldRunPackSmoke = process.argv.includes("--pack-smoke");

await checkRuntimeDependencies();

if (shouldRunPackSmoke) {
  await runPackSmoke();
}

async function checkRuntimeDependencies() {
  const serverPackage = await readJson(serverPackagePath);
  const animactlPackage = await readJson(animactlPackagePath);
  const serverDependencies = serverPackage.dependencies ?? {};
  const animactlDependencies = animactlPackage.dependencies ?? {};

  const missing = [];
  const mismatched = [];
  for (const [name, specifier] of Object.entries(serverDependencies).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const publishedSpecifier = animactlDependencies[name];
    if (publishedSpecifier === undefined) {
      missing.push(`${name}@${specifier}`);
    } else if (publishedSpecifier !== specifier) {
      mismatched.push(
        `${name}: server=${specifier}, animactl=${publishedSpecifier}`,
      );
    }
  }

  const extra = Object.keys(animactlDependencies)
    .filter((name) => serverDependencies[name] === undefined)
    .sort((a, b) => a.localeCompare(b));

  if (missing.length > 0 || mismatched.length > 0 || extra.length > 0) {
    const lines = [
      "packages/animactl publishes dist/server, so it must declare exactly the server runtime dependencies.",
    ];
    if (missing.length > 0) {
      lines.push(
        "",
        "Missing from packages/animactl/package.json:",
        ...missing.map((entry) => `  - ${entry}`),
      );
    }
    if (mismatched.length > 0) {
      lines.push(
        "",
        "Version specifier mismatch:",
        ...mismatched.map((entry) => `  - ${entry}`),
      );
    }
    if (extra.length > 0) {
      lines.push(
        "",
        "Not a server dependency (remove from packages/animactl/package.json):",
        ...extra.map((name) => `  - ${name}`),
      );
    }
    throw new Error(lines.join("\n"));
  }

  console.log(
    `animactl dependency boundary OK (${Object.keys(serverDependencies).length} server runtime deps covered)`,
  );
}

async function runPackSmoke() {
  const workDir = await mkdtemp(join(tmpdir(), "animactl-pack-smoke-"));
  try {
    const packDir = join(workDir, "pack");
    const installDir = join(workDir, "install");
    await mkdir(packDir, { recursive: true });
    await mkdir(installDir, { recursive: true });

    const pack = await run(
      "npm",
      ["pack", "--ignore-scripts", "--pack-destination", packDir, "--json"],
      {
        cwd: animactlPackageDir,
        capture: true,
      },
    );
    const [packInfo] = JSON.parse(pack.stdout);
    if (!packInfo?.filename) {
      throw new Error(
        `npm pack did not report a tarball filename: ${pack.stdout}`,
      );
    }
    assertPackedFile(packInfo, "docs/agent/guide.md");
    assertPackedFile(packInfo, "docs/agent/reference.md");
    assertPackedFile(packInfo, "docs/agent/recipes.md");
    assertPackedFile(packInfo, "docs/agent/feishu.md");
    assertNotPacked(packInfo, "dist/server/tests/");
    const tarballPath = join(packDir, basename(packInfo.filename));

    await writeFile(
      join(installDir, "package.json"),
      '{"private":true,"type":"module"}\n',
    );
    await run(
      "npm",
      ["install", tarballPath, "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: installDir },
    );

    const binDir = join(installDir, "node_modules", ".bin");
    const animaBin = join(
      binDir,
      process.platform === "win32" ? "anima.cmd" : "anima",
    );
    const animactlBin = join(
      binDir,
      process.platform === "win32" ? "animactl.cmd" : "animactl",
    );
    await assertCommandHelp(
      animaBin,
      ["env", "--help"],
      "Usage: anima env",
      installDir,
    );
    await assertCommandHelp(
      animactlBin,
      ["--help"],
      "Usage: animactl",
      installDir,
    );
    await assertCommandHelp(
      animactlBin,
      ["--version"],
      packInfo.version,
      installDir,
    );
    await assertCommandFails(
      animaBin,
      ["history"],
      "anima.no_agent_context",
      installDir,
    );
    await assertSingleNodeProcess(animaBin, ["--help"], workDir, installDir);

    const serverDir = join(
      installDir,
      "node_modules",
      "@meetquinn",
      "animactl",
      "dist",
      "server",
    );
    // The token usage store loads node:sqlite, which needs no flag only from
    // Node 22.13. CI runs this smoke on that version too.
    for (const modulePath of [
      join(serverDir, "env", "agent-env-store.js"),
      join(serverDir, "storage", "schema", "agent-token-usage.store.js"),
    ]) {
      await run(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `await import(${JSON.stringify(pathToFileURL(modulePath).href)});`,
        ],
        { cwd: installDir },
      );
    }

    console.log("animactl package smoke OK");
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
}

function assertPackedFile(packInfo, path) {
  const files = Array.isArray(packInfo.files) ? packInfo.files : [];
  if (!files.some((file) => file?.path === path)) {
    throw new Error(`animactl package is missing required file: ${path}`);
  }
}

function assertNotPacked(packInfo, prefix) {
  const files = Array.isArray(packInfo.files) ? packInfo.files : [];
  const packed = files.filter((file) => file?.path?.startsWith(prefix));
  if (packed.length > 0) {
    throw new Error(
      `animactl package must not include ${prefix} (${packed.length} files, e.g. ${packed[0].path})`,
    );
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function assertCommandHelp(command, args, expected, cwd) {
  const result = await run(command, args, { capture: true, cwd });
  if (!result.stdout.includes(expected)) {
    throw new Error(
      `${command} ${args.join(" ")} did not print expected help text "${expected}"`,
    );
  }
}

// The exit status and error output must come through the `anima` bin unchanged.
async function assertCommandFails(command, args, expected, cwd) {
  const env = { ...process.env };
  delete env.ANIMA_AGENT_ID;
  const result = await run(command, args, {
    allowFailure: true,
    capture: true,
    cwd,
    env,
  });
  if (result.code !== 1 || !result.stderr.includes(expected)) {
    throw new Error(
      `${command} ${args.join(" ")} should exit 1 with "${expected}", got exit ${result.code}${result.stderr ? `\n${result.stderr}` : ""}`,
    );
  }
}

// Agents call `anima` several times a turn; a second node process per call
// would add its startup to each one.
async function assertSingleNodeProcess(command, args, workDir, cwd) {
  const pidLog = join(workDir, "anima-pids.log");
  const hook = join(workDir, "record-pid.mjs");
  await writeFile(
    hook,
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(pidLog)}, \`\${process.pid}\\n\`);\n`,
  );
  const env = {
    ...process.env,
    NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`,
  };
  await run(command, args, { capture: true, cwd, env });
  const pids = (await readFile(pidLog, "utf8")).trim().split("\n");
  if (pids.length !== 1) {
    throw new Error(
      `${command} ${args.join(" ")} ran ${pids.length} node processes, expected 1`,
    );
  }
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (options.capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0 || (options.allowFailure && !signal)) {
        resolveRun({ code, stderr, stdout });
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit ${code}`;
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with ${detail}${stderr ? `\n${stderr}` : ""}`,
        ),
      );
    });
  });
}
