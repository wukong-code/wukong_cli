import { CLI_COMMAND_NAME } from '#/constant/app';
import { registerMigrateCommand } from '#/migration/index';
import { Command, Option } from 'commander';

import type { CLIOptions } from './options';
import { registerAcpCommand } from './sub/acp';
import { registerDoctorCommand } from './sub/doctor';
import { registerExportCommand } from './sub/export';
import { registerGuardCommand } from './sub/guard';
import { registerJudgeCommand } from './sub/judge';
import { registerLoginCommand } from './sub/login';
import { parseVerificationSkills, registerLoopCommand } from './sub/loop';
import { registerProofCommand } from './sub/proof';
import { registerProviderCommand } from './sub/provider';
import { registerReviewCommand } from './sub/review';
import { registerRolesCommand } from './sub/roles';
import { registerScanCommand } from './sub/scan';
import { registerServerCommand } from './sub/server';
import { registerTodayCommand } from './sub/today';
import { registerVisCommand } from './sub/vis';
import { registerVerifyCommand } from './sub/verify';

export type MainCommandHandler = (opts: CLIOptions) => void;
export type MigrateCommandHandler = () => void;
export type PluginNodeRunnerHandler = (entry: string, args: readonly string[]) => void;
export type UpgradeCommandHandler = () => void | Promise<void>;

export function createProgram(
  version: string,
  onMain: MainCommandHandler,
  onMigrate: MigrateCommandHandler,
  onPluginNodeRunner: PluginNodeRunnerHandler = () => {},
  onUpgrade: UpgradeCommandHandler = () => {},
): Command {
  const program = new Command(CLI_COMMAND_NAME)
    .description('Wukong Code — local-first AI coding agent in your terminal.')
    .version(version, '-V, --version')
    .allowUnknownOption(false)
    .configureHelp({ helpWidth: 100 })
    .helpOption('-h, --help', 'Show help.')
    .usage('[options] [command]')
    .addHelpText('after', '\nDocumentation:        https://docs.wukong.today\n');

  program
    .addOption(
      new Option(
        '-S, --session [id]',
        'Resume a session. With ID: resume that session. Without ID: interactively pick.',
      ).argParser((val: string | boolean) => (val === true ? '' : (val as string))),
    )
    .addOption(
      new Option('-r, --resume [id]')
        .hideHelp()
        .argParser((val: string | boolean) => (val === true ? '' : (val as string))),
    )
    .option('-c, --continue', 'Continue the previous session for the working directory.', false)
    .addOption(new Option('-C').hideHelp().default(false))
    .option('-y, --yolo', 'Skip ordinary approvals (dangerous; profile limits still apply).', false)
    .option('--auto', 'Run autonomously with workspace and high-risk guardrails.', false)
    .addOption(
      new Option(
        '-m, --model <model>',
        'LLM model alias to use for this invocation. Defaults to default_model in config.toml.',
      ),
    )
    .addOption(
      new Option(
        '-p, --prompt <prompt>',
        'Run one prompt non-interactively and print the response.',
      ),
    )
    .addOption(
      new Option(
        '--output-format <format>',
        'Output format for prompt mode. Defaults to text.',
      ).choices(['text', 'stream-json']),
    )
    .addOption(
      new Option(
        '--skills-dir <dir>',
        'Load skills from this directory instead of auto-discovered user and project directories. Can be repeated.',
      )
        .argParser((value: string, previous: string[] | undefined) => [...(previous ?? []), value])
        .default([]),
    )
    .addOption(
      new Option(
        '--add-dir <dir>',
        'Add an additional workspace directory for this session. Can be repeated.',
      )
        .argParser((value: string, previous: string[] | undefined) => [...(previous ?? []), value])
        .default([]),
    )
    .addOption(new Option('--yes').hideHelp().default(false))
    .addOption(new Option('--auto-approve').hideHelp().default(false))
    .option('--plan', 'Start in plan mode.', false);

  registerExportCommand(program);
  registerProviderCommand(program);
  registerAcpCommand(program);
  registerServerCommand(program);
  registerVerifyCommand(program);
  registerScanCommand(program);
  registerProofCommand(program);
  registerJudgeCommand(program);
  registerLoopCommand(program, (loop) => {
    const raw = program.opts<Record<string, unknown>>();
    const rawSession = raw['session'] ?? raw['resume'];
    const session = rawSession === true ? '' : rawSession as string | undefined;
    const legacyAutoApprove = raw['autoApprove'] === true;
    const yolo = raw['yolo'] === true || legacyAutoApprove;
    onMain({
      session,
      continue: raw['continue'] === true || raw['C'] === true,
      yolo,
      yes: raw['yes'] === true || legacyAutoApprove,
      auto: raw['auto'] === true || !yolo,
      plan: raw['plan'] === true,
      model: loop.model ?? raw['model'] as string | undefined,
      outputFormat: raw['outputFormat'] as CLIOptions['outputFormat'],
      prompt: loop.objective,
      headlessGoal: {
        kind: 'loop',
        objective: loop.objective!,
        replace: false,
        stopCondition: 'proof-pass',
        maxIterations: loop.maxIterations!,
        ...(loop.minIntervalMs === undefined ? {} : { minIntervalMs: loop.minIntervalMs }),
        ...(loop.reviewModel === undefined ? {} : { reviewModel: loop.reviewModel }),
        ...(loop.doneWhen === undefined ? {} : { completionCriterion: loop.doneWhen }),
        constraints: loop.constraints ?? [],
        checks: loop.checks ?? [],
        ...(loop.acceptDiscoveredChecks === true
          ? { discoveredCheckDecision: 'accept' as const }
          : loop.onlyExplicitChecks === true
            ? { discoveredCheckDecision: 'only-explicit' as const }
            : {}),
        ...(loop.trustWorkspaceChallenge === undefined
          ? {}
          : { trustWorkspaceChallenge: loop.trustWorkspaceChallenge }),
        ...(loop.approveGatePlanDigest === undefined
          ? {}
          : { approveGatePlanDigest: loop.approveGatePlanDigest }),
        ...(loop.approveBootstrapPlanDigest === undefined
          ? {}
          : {
              approveBootstrapPlanDigest:
                loop.approveBootstrapPlanDigest,
            }),
        ...(loop.acknowledgeWarningSetDigest === undefined
          ? {}
          : { acknowledgeWarningSetDigest: loop.acknowledgeWarningSetDigest }),
        ...(loop.verificationCatalogDigest === undefined
          ? {}
          : { verificationCatalogDigest: loop.verificationCatalogDigest }),
        verificationSkills: parseVerificationSkills(loop.verificationSkills),
        ...(loop.trustReviewSubjectChallenge === undefined
          ? {}
          : {
              trustReviewSubjectChallenge:
                loop.trustReviewSubjectChallenge,
            }),
        ...(loop.acknowledgeReviewSubjectConsentDigest === undefined
          ? {}
          : {
              acknowledgeReviewSubjectConsentDigest:
                loop.acknowledgeReviewSubjectConsentDigest,
            }),
        ...((loop.includeUntracked?.length ?? 0) === 0
          ? {}
          : {
              selectedUntrackedPaths:
                loop.includeUntracked,
            }),
        ...(loop.promoteCandidateDigest === undefined
          ? {}
          : {
              promoteCandidateDigest:
                loop.promoteCandidateDigest,
            }),
      },
      skillsDirs: raw['skillsDir'] as string[],
      addDirs: raw['addDir'] as string[],
    });
  });
  registerGuardCommand(program);
  registerLoginCommand(program);
  registerReviewCommand(program);
  registerRolesCommand(program);
  registerDoctorCommand(program);
  registerTodayCommand(program);
  registerVisCommand(program);
  registerMigrateCommand(program, onMigrate);
  program
    .command('upgrade')
    .alias('update')
    .description('Upgrade Wukong to the latest version.')
    .action(async () => {
      await onUpgrade();
    });

  program
    .command('__plugin_run_node', { hidden: true })
    .argument('<entry>')
    .argument('[args...]')
    .allowUnknownOption(true)
    .action((entry: string, args: string[]) => {
      onPluginNodeRunner(entry, args);
    });

  program.argument('[args...]').action((args: string[]) => {
    if (args.length > 0) {
      program.error(`unknown command '${args[0]}'. See '${CLI_COMMAND_NAME} --help'.`);
    }

    const raw = program.opts<Record<string, unknown>>();

    const rawSession = raw['session'] ?? raw['resume'];
    const sessionValue = rawSession === true ? '' : (rawSession as string | undefined);
    const legacyAutoApprove = raw['autoApprove'] === true;
    const yoloValue = raw['yolo'] === true || legacyAutoApprove;
    const yesValue = raw['yes'] === true || legacyAutoApprove;
    const promptValue = raw['prompt'] as string | undefined;
    const autoValue = raw['auto'] === true || (promptValue !== undefined && !yoloValue);
    if (legacyAutoApprove) {
      process.stderr.write(
        'Warning: --auto-approve is deprecated and maps to dangerous YOLO mode. Use --yolo explicitly.\n',
      );
    }

    const opts: CLIOptions = {
      session: sessionValue,
      continue: raw['continue'] === true || raw['C'] === true,
      yolo: yoloValue,
      yes: yesValue,
      auto: autoValue,
      plan: raw['plan'] as boolean,
      model: raw['model'] as string | undefined,
      outputFormat: raw['outputFormat'] as CLIOptions['outputFormat'],
      prompt: promptValue,
      skillsDirs: raw['skillsDir'] as string[],
      addDirs: raw['addDir'] as string[],
    };

    onMain(opts);
  });

  return program;
}
