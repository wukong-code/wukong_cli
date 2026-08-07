import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  appRoot,
  executableName,
  nativeBinPath,
  targetTriple,
} from './paths.mjs';
import { nativeLoopDryRunSmoke, nativePromptResumeSmoke } from './smoke-plan.mjs';
import { createNativeSmokeProvider } from './smoke-provider.mjs';

const execFileAsync = promisify(execFile);
const target = targetTriple();
let executablePath = nativeBinPath(target);
const smokeHome = await mkdtemp(resolve(tmpdir(), 'wukong-native-home-'));
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

async function runWukongWithEnv(args, env, cwd = appRoot) {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, args, {
      cwd,
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

async function runWukongAllowExit(args, allowedExitCodes, cwd = appRoot) {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, args, {
      cwd,
      env: {
        ...process.env,
        WUKONG_CODE_HOME: smokeHome,
        WUKONG_CODE_NO_AUTO_UPDATE: '1',
        WUKONG_TELEMETRY: '0',
      },
      maxBuffer: 1024 * 1024 * 16,
    });
    return { output: `${stdout}${stderr}`, exitCode: 0 };
  } catch (error) {
    const exitCode = typeof error.code === 'number' ? error.code : undefined;
    if (exitCode !== undefined && allowedExitCodes.includes(exitCode)) {
      return { output: `${error.stdout ?? ''}${error.stderr ?? ''}`, exitCode };
    }
    const detail = [error.stdout?.trim(), error.stderr?.trim(), error.message]
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

const freshProviderOutput = await runWukong(['provider', 'list', '--json']);
assertIncludes(freshProviderOutput, '"providers":', 'fresh-home provider list smoke');
assertIncludes(freshProviderOutput, '"models":', 'fresh-home provider list smoke');
try {
  await stat(resolve(smokeHome, 'config.toml'));
} catch {
  fail('Fresh-home provider list smoke did not create config.toml.');
}

if (process.env['WUKONG_CODE_EXPECT_BUILT_IN_CATALOG'] === '1') {
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
}

const loopSmoke = nativeLoopDryRunSmoke();
const loopWorkspace = resolve(smokeHome, 'workspace with space 雪');
await mkdir(loopWorkspace, { recursive: true });
await writeFile(resolve(smokeHome, 'config.toml'), loopSmoke.config, 'utf8');
const loopDryRunOutput = await runWukongWithEnv(loopSmoke.args, {}, loopWorkspace);
const compactLoopDryRunOutput = loopDryRunOutput.replaceAll(/\s+/gu, '');
for (const expected of loopSmoke.expectedOutput) {
  assertIncludes(compactLoopDryRunOutput, expected, 'native Loop dry-run smoke');
}
if (loopDryRunOutput.includes('native-smoke-key')) {
  fail('Native Loop dry-run smoke leaked the configured provider API key.');
}

const provider = await createNativeSmokeProvider();
try {
  const promptSmoke = nativePromptResumeSmoke(provider.baseUrl);
  await writeFile(resolve(smokeHome, 'config.toml'), promptSmoke.config, 'utf8');
  const firstPromptOutput = await runWukongWithEnv(promptSmoke.firstArgs, {}, loopWorkspace);
  const firstRecords = jsonRecords(firstPromptOutput);
  const firstSummary = firstRecords.find((record) => record.type === 'run.summary');
  const firstAssistant = firstRecords.find((record) => record.role === 'assistant');
  const sessionId = typeof firstSummary?.session_id === 'string'
    ? firstSummary.session_id
    : undefined;
  if (sessionId === undefined) {
    fail(`Native prompt smoke did not report a resumable session id.\n${firstPromptOutput}`);
  }
  if (
    typeof firstAssistant?.content !== 'string'
    || !firstAssistant.content.includes(promptSmoke.expectedAssistant[0])
  ) {
    fail(`Native prompt smoke did not emit the expected provider response.\n${firstPromptOutput}`);
  }

  const resumeOutput = await runWukongWithEnv(
    promptSmoke.resumeArgs(sessionId),
    {},
    loopWorkspace,
  );
  const resumeRecords = jsonRecords(resumeOutput);
  const resumeSummary = resumeRecords.find((record) => record.type === 'run.summary');
  const resumeAssistant = resumeRecords.find((record) => record.role === 'assistant');
  if (resumeSummary?.session_id !== sessionId) {
    fail(`Native Resume smoke changed session identity.\n${resumeOutput}`);
  }
  if (
    typeof resumeAssistant?.content !== 'string'
    || !resumeAssistant.content.includes(promptSmoke.expectedAssistant[1])
  ) {
    fail(`Native Resume smoke did not emit the expected provider response.\n${resumeOutput}`);
  }
  if (
    provider.requests.length !== 2
    || provider.requests.some((request) => (
      request.authorization !== 'Bearer native-smoke-key'
      || request.model !== 'native-smoke-model'
    ))
  ) {
    fail(`Native provider smoke observed invalid request identity: ${JSON.stringify(provider.requests)}`);
  }
  const firstInput = provider.requests[0]?.body?.input;
  const resumedInput = provider.requests[1]?.body?.input;
  if (
    !Array.isArray(firstInput)
    || !Array.isArray(resumedInput)
    || resumedInput.length <= firstInput.length
  ) {
    fail('Native Resume smoke did not send the persisted first turn as prior context.');
  }
  if (`${firstPromptOutput}${resumeOutput}`.includes('native-smoke-key')) {
    fail('Native prompt/Resume smoke leaked the configured provider API key.');
  }

  const dynamicLoopSmoke = nativeLoopDryRunSmoke(provider.baseUrl);
  const dynamicLoopDryRunOutput = await runWukongWithEnv(
    dynamicLoopSmoke.args,
    {},
    loopWorkspace,
  );
  const dynamicPlan = parseJsonDocument(dynamicLoopDryRunOutput);
  const headlessStart = dynamicPlan?.headlessStart;
  if (typeof headlessStart !== 'object' || headlessStart === null) {
    fail(`Native Loop smoke did not produce headless start bindings.\n${dynamicLoopDryRunOutput}`);
  }
  const actualLoopArgs = dynamicLoopSmoke.args.filter((argument) => argument !== '--dry-run');
  const maxIterationsIndex = actualLoopArgs.indexOf('--max-iterations');
  if (maxIterationsIndex >= 0) actualLoopArgs[maxIterationsIndex + 1] = '1';
  for (const [flag, field] of [
    ['--approve-gate-plan', 'approveGatePlanDigest'],
    ['--ack-finish-line-warnings', 'acknowledgeWarningSetDigest'],
    ['--ack-no-executable-checks', 'acknowledgeNoExecutableChecksDigest'],
    ['--trust-workspace', 'trustWorkspaceChallenge'],
    ['--trust-review-subject', 'trustReviewSubjectChallenge'],
    ['--ack-review-subject', 'acknowledgeReviewSubjectConsentDigest'],
    ['--verification-catalog-digest', 'verificationCatalogDigest'],
  ]) {
    const value = headlessStart[field];
    if (typeof value === 'string' && value.length > 0) actualLoopArgs.push(flag, value);
  }
  const loopRun = await runWukongAllowExit(actualLoopArgs, [1, 2], loopWorkspace);
  const loopResult = jsonRecords(loopRun.output).find((record) => record.type === 'loop.result');
  if (
    loopResult === undefined
    || loopResult.status === 'PASS'
    || loopResult.iterations !== 1
  ) {
    fail(`Native Loop smoke did not fail closed after its single unproved iteration.\n${loopRun.output}`);
  }
  if (loopRun.output.includes('native-smoke-key')) {
    fail('Native Loop smoke leaked the configured provider API key.');
  }
  if (provider.requests.length < 3) {
    fail('Native Loop smoke did not reach the configured provider.');
  }
} finally {
  await provider.close();
}

console.log(`Native smoke passed: ${executablePath}`);

function jsonRecords(output) {
  const records = [];
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) records.push(parsed);
    } catch {
      // Diagnostic text may start with a brace; only complete JSONL records matter here.
    }
  }
  return records;
}

function parseJsonDocument(output) {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end < start) return undefined;
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
