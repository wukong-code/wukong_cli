import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  appRoot,
  executableName,
  nativeBinPath,
  nativeSmokeHome,
  targetTriple,
} from './paths.mjs';

const execFileAsync = promisify(execFile);
const target = targetTriple();
let executablePath = nativeBinPath(target);
const smokeHome = nativeSmokeHome();
const packageJson = JSON.parse(await readFile(resolve(appRoot, 'package.json'), 'utf-8'));
const expectedVersion = packageJson.version;

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function usePackagedExecutableIfRequested() {
  const archivePath = process.env['WUKONG_CODE_NATIVE_SMOKE_ARCHIVE'];
  if (archivePath === undefined || archivePath.length === 0) return;

  const extractDir = await mkdtemp(resolve(tmpdir(), 'wukong-native-archive-smoke-'));
  if (process.platform === 'win32') {
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -LiteralPath $env:WUKONG_CODE_NATIVE_SMOKE_ARCHIVE -DestinationPath $env:WUKONG_CODE_NATIVE_SMOKE_EXTRACT_DIR -Force',
      ],
      {
        env: {
          ...process.env,
          WUKONG_CODE_NATIVE_SMOKE_EXTRACT_DIR: extractDir,
        },
      },
    );
  } else {
    await execFileAsync('unzip', ['-q', archivePath, '-d', extractDir]);
  }

  executablePath = resolve(
    extractDir,
    executableName(target.startsWith('win32-') ? 'win32' : process.platform),
  );
  if (process.platform !== 'win32') await chmod(executablePath, 0o755);
  console.log(`Smoke testing packaged executable from ${archivePath}`);
}

async function ensureExecutableExists() {
  try {
    await stat(executablePath);
  } catch {
    fail(`Native executable not found at ${executablePath}. Run build:native:sea first.`);
  }
}

async function runWukong(args) {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, args, {
      cwd: appRoot,
      env: {
        ...process.env,
        WUKONG_CODE_HOME: smokeHome,
        WUKONG_CODE_NO_AUTO_UPDATE: '1',
        WUKONG_TELEMETRY: '0',
      },
      maxBuffer: 1024 * 1024 * 16,
    });
    return `${stdout}${stderr}`;
  } catch (error) {
    const detail = [
      error.stdout?.trim(),
      error.stderr?.trim(),
      error.code !== undefined ? `exit code: ${String(error.code)}` : null,
      error.signal !== undefined && error.signal !== null
        ? `signal: ${String(error.signal)}`
        : null,
      error.message,
    ]
      .filter(Boolean)
      .join('\n');
    fail(`Native smoke failed: ${executablePath} ${args.join(' ')}\n${detail}`);
  }
}

async function runWukongWithEnv(args, env) {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, args, {
      cwd: appRoot,
      env: {
        ...process.env,
        WUKONG_CODE_HOME: smokeHome,
        WUKONG_CODE_NO_AUTO_UPDATE: '1',
        WUKONG_TELEMETRY: '0',
        ...env,
      },
      maxBuffer: 1024 * 1024 * 16,
    });
    return `${stdout}${stderr}`;
  } catch (error) {
    const detail = [
      error.stdout?.trim(),
      error.stderr?.trim(),
      error.code !== undefined ? `exit code: ${String(error.code)}` : null,
      error.signal !== undefined && error.signal !== null
        ? `signal: ${String(error.signal)}`
        : null,
      error.message,
    ]
      .filter(Boolean)
      .join('\n');
    fail(`Native smoke failed: ${executablePath} ${args.join(' ')}\n${detail}`);
  }
}

function assertIncludes(output, expected, command) {
  if (!output.includes(expected)) {
    fail(`Native smoke output for "${command}" did not include "${expected}".\n${output}`);
  }
}

await usePackagedExecutableIfRequested();
await ensureExecutableExists();

const versionOutput = await runWukong(['--version']);
assertIncludes(versionOutput, expectedVersion, '--version');

const helpOutput = await runWukong(['--help']);
assertIncludes(helpOutput, 'Usage: wukong', '--help');

const exportHelpOutput = await runWukong(['export', '--help']);
assertIncludes(exportHelpOutput, 'Usage: wukong export', 'export --help');

const nativeAssetOutput = await runWukongWithEnv(['--version'], {
  WUKONG_CODE_HOME: smokeHome,
  WUKONG_CODE_NATIVE_ASSET_SMOKE: '1',
});
assertIncludes(nativeAssetOutput, `Native asset smoke passed: ${target}`, 'native asset smoke');

const offlineCatalogOutput = await runWukongWithEnv(
  ['provider', 'catalog', 'list', 'openai', '--json'],
  {
    WUKONG_CODE_HOME: smokeHome,
    WUKONG_CODE_CATALOG_OFFLINE: '1',
    WUKONG_CODE_NO_AUTO_UPDATE: '1',
    WUKONG_TELEMETRY: '0',
  },
);
assertIncludes(
  offlineCatalogOutput,
  'using the built-in snapshot',
  'offline provider catalog smoke',
);
assertIncludes(offlineCatalogOutput, '"providerId": "openai"', 'offline provider catalog smoke');

console.log(`Native smoke passed: ${executablePath}`);
