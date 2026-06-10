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

  if (missing.length > 0 || mismatched.length > 0) {
    const lines = [
      "packages/animactl publishes dist/server, so it must declare every server runtime dependency.",
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

    const envStorePath = join(
      installDir,
      "node_modules",
      "@meetquinn",
      "animactl",
      "dist",
      "server",
      "env",
      "agent-env-store.js",
    );
    await run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(pathToFileURL(envStorePath).href)});`,
      ],
      { cwd: installDir },
    );

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

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
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
      if (code === 0) {
        resolveRun({ stderr, stdout });
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
