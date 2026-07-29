import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  appRoot,
  executableName,
  nativeArtifactsDir,
  targetTriple,
} from './paths.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(appRoot, '..', '..');
const installer = resolve(repositoryRoot, 'install.sh');
const target = targetTriple();
const currentVersion = JSON.parse(
  await readFile(resolve(appRoot, 'package.json'), 'utf8'),
).version;
const upgradeFromVersion =
  process.env.WUKONG_NATIVE_UPGRADE_FROM_VERSION ?? '';
const temporaryRoot = await mkdtemp(
  resolve(process.env.RUNNER_TEMP ?? tmpdir(), 'wukong-native-install-'),
);
const artifactBaseUrl = pathToFileURL(
  `${nativeArtifactsDir()}${sep}`,
).href.replace(/\/$/u, '');

try {
  await verifyFreshInstall();
  if (upgradeFromVersion !== '') {
    await verifyUpgrade();
  }
  process.stdout.write(
    `Native installer smoke passed: ${target} v${currentVersion}\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function verifyFreshInstall() {
  const installDirectory = resolve(temporaryRoot, 'fresh', 'bin');
  await runInstaller({
    installDirectory,
    version: currentVersion,
    artifactBaseUrl,
  });
  await expectInstalledVersion(
    installDirectory,
    currentVersion,
    'fresh install',
  );
}

async function verifyUpgrade() {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(upgradeFromVersion)) {
    fail(
      'WUKONG_NATIVE_UPGRADE_FROM_VERSION must be MAJOR.MINOR.PATCH.',
    );
  }
  if (upgradeFromVersion === currentVersion) {
    fail(
      `Upgrade source v${upgradeFromVersion} equals the current build.`,
    );
  }
  const installDirectory = resolve(temporaryRoot, 'upgrade', 'bin');
  await runInstaller({
    installDirectory,
    version: upgradeFromVersion,
  });
  await expectInstalledVersion(
    installDirectory,
    upgradeFromVersion,
    'upgrade preimage',
  );
  await runInstaller({
    installDirectory,
    version: currentVersion,
    artifactBaseUrl,
  });
  await expectInstalledVersion(
    installDirectory,
    currentVersion,
    'upgrade postimage',
  );
}

async function runInstaller({
  installDirectory,
  version,
  artifactBaseUrl: selectedArtifactBaseUrl,
}) {
  const env = {
    ...process.env,
    WUKONG_VERSION: `v${version}`,
    WUKONG_INSTALL_DIR: installDirectory,
    WUKONG_INSTALL_TARGET: target,
  };
  if (selectedArtifactBaseUrl === undefined) {
    delete env.WUKONG_ARTIFACT_BASE_URL;
  } else {
    env.WUKONG_ARTIFACT_BASE_URL = selectedArtifactBaseUrl;
  }
  try {
    await execFileAsync('bash', [installer], {
      cwd: repositoryRoot,
      env,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    fail([
      `Installer failed for ${target} v${version}.`,
      error.stdout,
      error.stderr,
      error.message,
    ].filter(Boolean).join('\n'));
  }
}

async function expectInstalledVersion(
  installDirectory,
  version,
  stage,
) {
  const executable = resolve(
    installDirectory,
    executableName(target.startsWith('win32-') ? 'win32' : process.platform),
  );
  try {
    const { stdout, stderr } = await execFileAsync(
      executable,
      ['--version'],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PATH: `${installDirectory}${delimiter}${process.env.PATH ?? ''}`,
          WUKONG_CODE_HOME: resolve(temporaryRoot, 'home', stage),
          WUKONG_CODE_NO_AUTO_UPDATE: '1',
          WUKONG_TELEMETRY: '0',
        },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const actual = `${stdout}${stderr}`.trim();
    if (actual !== version) {
      fail(
        `${stage} expected Wukong ${version}, received ${actual || '[empty]'}.`,
      );
    }
  } catch (error) {
    fail([
      `${stage} could not execute ${executable}.`,
      error.stdout,
      error.stderr,
      error.message,
    ].filter(Boolean).join('\n'));
  }
}

function fail(message) {
  throw new Error(message);
}
