import { CLI_COMMAND_NAME } from '#/constant/app';
import { registerMigrateCommand } from '#/migration/index';
import { Command, Help, Option } from 'commander';

import type { CLIOptions } from './options';
import { registerAcpCommand } from './sub/acp';
import { registerCheckCommand } from './sub/check';
import { registerDoctorCommand } from './sub/doctor';
import { registerExportCommand } from './sub/export';
import { registerGateCommand } from './sub/gate';
import { registerGuardCommand } from './sub/guard';
import { registerInitCommand } from './sub/init';
import { registerJudgeCommand } from './sub/judge';
import { registerLoginCommand } from './sub/login';
import { registerLogoutCommand } from './sub/logout';
import { registerLoopCommand, parseVerificationSkills } from './sub/loop';
import { registerMcpCommand } from './sub/mcp';
import { registerProofCommand } from './sub/proof';
import { registerProviderCommand } from './sub/provider';
import { registerReviewCommand } from './sub/review';
import { registerRolesCommand } from './sub/roles';
import { registerScanCommand } from './sub/scan';
import { registerServerCommand } from './sub/server';
import { registerSummaryCommand } from './sub/summary';
import { registerTodayCommand } from './sub/today';
import { registerVisCommand } from './sub/vis';
import { registerVerifyCommand } from './sub/verify';

export const CLI_CORE_COMMANDS = [
  'init',
  'check',
  'gate',
  'summary',
  'loop',
  'provider',
  'doctor',
  'upgrade',
] as const;

export const CLI_ADVANCED_COMMANDS = [
  'mcp',
  'export',
  'review',
  'roles',
  'today',
  'guard',
  'judge',
  'login',
  'logout',
  'web',
] as const;

export const CLI_HIDDEN_COMMANDS = [
  'verify',
  'scan',
  'proof',
  'vis',
  'acp',
  'server',
  'migrate',
] as const;

export type MainCommandHandler = (opts: CLIOptions) => void;
export type MigrateCommandHandler = () => void;
export type PluginNodeRunnerHandler = (entry: string, args: readonly string[]) => void;
export type UpgradeCommandHandler = () => void | Promise<void>;

export function formatAllCommandsHelp(program: Command): string {
  const byName = new Map(program.commands.map((sub) => [sub.name(), sub]));
  const helper = program.createHelp();
  const formatGroup = (title: string, names: readonly string[]): string[] => {
    const subs = names
      .map((name) => byName.get(name))
      .filter((cmd): cmd is Command => cmd !== undefined);
    if (subs.length === 0) return [];
    const terms = subs.map((cmd) => helper.subcommandTerm(cmd));
    const width = Math.max(20, ...terms.map((term) => term.length));
    return [
      `${title}:`,
      ...subs.map((cmd, idx) => `  ${(terms[idx] ?? cmd.name()).padEnd(width)}  ${cmd.description()}`),
      '',
    ];
  };

  return [
    program.helpInformation().trimEnd(),
    '',
    ...formatGroup('Advanced Commands', CLI_ADVANCED_COMMANDS),
    ...formatGroup('Diagnostics & Compatibility', CLI_HIDDEN_COMMANDS),
  ].join('\n');
}

export function createProgram(
  version: string,
  onMain: MainCommandHandler,
  onMigrate: MigrateCommandHandler,
  onPluginNodeRunner: PluginNodeRunnerHandler = () => {},
  onUpgrade: UpgradeCommandHandler = () => {},
): Command {
  const program = new Command(CLI_COMMAND_NAME);
  program
    .description('Wukong Code — local-first AI coding agent and delivery verification gate.')
    .version(version, '-V, --version')
    .enablePositionalOptions()
    .allowUnknownOption(false)
    .addHelpCommand(false)
    .configureHelp({
      helpWidth: 100,
      visibleCommands(cmd: Command): Command[] {
        if (cmd !== program) {
          return Help.prototype.visibleCommands.call(this, cmd);
        }
        const byName = new Map(cmd.commands.map((sub) => [sub.name(), sub]));
        const visible: Command[] = [];
        for (const name of CLI_CORE_COMMANDS) {
          const sub = byName.get(name);
          if (sub !== undefined) {
            visible.push(sub);
          }
        }
        return visible;
      },
    })
    .helpOption('-h, --help', 'Show help.')
    .usage('[options] [command]')
    .addHelpText(
      'after',
      '\nMore commands:        wukong help --all\nDocumentation:        https://docs.wukong.today\n',
    );

  program
    .addOption(
      new Option(
        '-r, --resume [id]',
        'Resume a session. With ID: resume that session. Without ID: interactively pick.',
      ).argParser((val: string | boolean) => (val === true ? '' : (val as string))),
    )
    .addOption(
      new Option('-S, --session [id]')
        .hideHelp()
        .argParser((val: string | boolean) => (val === true ? '' : (val as string))),
    )
    .option('-c, --continue', 'Resume the most recent session for the current working directory.')
    .addOption(new Option('-C').hideHelp())
    .option(
      '--auto',
      'Auto-approve ordinary actions; block at workspace and high-risk boundaries.',
    )
    .option(
      '-y, --yolo',
      'Skip ordinary approvals. Dangerous; profile and safety limits still apply. Headless runs require --yes.',
    )
    .option(
      '--plan',
      'Start in planning mode to analyze and propose before implementation.',
    )
    .addOption(
      new Option(
        '-p, --prompt <prompt>',
        'Run one headless turn in guarded Auto mode; may modify the workspace.',
      ),
    )
    .addOption(
      new Option(
        '--output-format <format>',
        'Output format for headless prompt or Loop mode. Defaults to text.',
      ).choices(['text', 'stream-json']),
    )
    .addOption(
      new Option('--yes', 'Confirm --yolo for a headless prompt or Loop run.'),
    )
    .addOption(
      new Option(
        '-m, --model <model>',
        'LLM model alias to use for this invocation. Defaults to default_model in config.toml.',
      ),
    )
    .addOption(
      new Option(
        '--skills-dir <dir>',
        'Use this skill directory instead of auto-discovered user and project skill directories. Can be repeated.',
      )
        .argParser((value: string, previous: string[] | undefined) => [...(previous ?? []), value]),
    )
    .addOption(
      new Option(
        '--add-dir <dir>',
        'Grant this session access to an additional workspace directory. Can be repeated.',
      )
        .argParser((value: string, previous: string[] | undefined) => [...(previous ?? []), value]),
    )
    .addOption(new Option('--auto-approve').hideHelp());

  registerExportCommand(program);
  registerInitCommand(program);
  registerCheckCommand(program);
  registerGateCommand(program);
  registerSummaryCommand(program);
  registerMcpCommand(program);
  registerProviderCommand(program);
  registerAcpCommand(program);
  registerServerCommand(program);
  registerVerifyCommand(program);
  registerScanCommand(program);
  registerProofCommand(program);
  registerJudgeCommand(program);
  registerLoopCommand(program, (loop, globals) => {
    const raw = program.opts<Record<string, unknown>>();
    const rawSession = raw['session'] ?? raw['resume'];
    const fallbackSession = rawSession === true ? '' : rawSession as string | undefined;
    const legacyAutoApprove = raw['autoApprove'] === true;
    const fallbackYolo = raw['yolo'] === true || legacyAutoApprove;
    const session = globals?.session ?? fallbackSession;
    const continueFlag = globals?.continue ?? (raw['continue'] === true || raw['C'] === true);
    const yolo = globals?.yolo ?? fallbackYolo;
    const yes = globals?.yes ?? (raw['yes'] === true || legacyAutoApprove);
    const auto = globals?.auto ?? (raw['auto'] === true || !yolo);
    const outputFormat = globals?.outputFormat ?? (raw['outputFormat'] as CLIOptions['outputFormat']);
    const skillsDirs = globals === undefined
      ? ((raw['skillsDir'] as string[] | undefined) ?? [])
      : [...globals.skillsDirs];
    const addDirs = globals === undefined
      ? ((raw['addDir'] as string[] | undefined) ?? [])
      : [...globals.addDirs];
    onMain({
      session,
      continue: continueFlag,
      yolo,
      yes,
      auto,
      plan: false,
      model: loop.model ?? raw['model'] as string | undefined,
      outputFormat,
      prompt: loop.objective,
      headlessGoal: {
        kind: 'loop',
        objective: loop.objective!,
        replace: false,
        stopCondition: 'proof-pass',
        maxIterations: loop.maxIterations!,
        ...(loop.writerProviderCallLimit === undefined
          ? {}
          : { writerProviderCallLimit: loop.writerProviderCallLimit }),
        ...(loop.reviewerProviderCallLimit === undefined
          ? {}
          : { reviewerProviderCallLimit: loop.reviewerProviderCallLimit }),
        ...(loop.tokenBudget === undefined ? {} : { tokenBudget: loop.tokenBudget }),
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
        ...(loop.acknowledgeWarningSetDigest === undefined
          ? {}
          : { acknowledgeWarningSetDigest: loop.acknowledgeWarningSetDigest }),
        ...(loop.acknowledgeNoExecutableChecksDigest === undefined
          ? {}
          : {
              acknowledgeNoExecutableChecksDigest:
                loop.acknowledgeNoExecutableChecksDigest,
            }),
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
      },
      skillsDirs,
      addDirs,
    });
  });
  registerGuardCommand(program);
  registerLoginCommand(program);
  registerLogoutCommand(program);
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
    .command('help [command]', { hidden: true })
    .description('Display help for wukong or a specific command.')
    .option('--all', 'Show all commands, including advanced and diagnostic aliases.', false)
    .action((commandName: string | undefined, opts: { all?: boolean }) => {
      const outputConfig = program.configureOutput();
      const writeOut = (text: string): void => {
        if (outputConfig.writeOut !== undefined) {
          outputConfig.writeOut(text);
          return;
        }
        process.stdout.write(text);
      };
      if (opts.all === true) {
        writeOut(formatAllCommandsHelp(program));
        return;
      }
      if (commandName !== undefined) {
        const target = program.commands.find(
          (cmd: Command) =>
            cmd.name() !== '__plugin_run_node'
            && cmd.name() !== 'help'
            && (cmd.name() === commandName || cmd.aliases().includes(commandName)),
        );
        if (target === undefined) {
          program.error(`unknown command '${commandName}'. See '${CLI_COMMAND_NAME} --help'.`);
          return;
        }
        writeOut(target.helpInformation());
        return;
      }
      program.outputHelp();
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
      plan: raw['plan'] === true,
      model: raw['model'] as string | undefined,
      outputFormat: raw['outputFormat'] as CLIOptions['outputFormat'],
      prompt: promptValue,
      skillsDirs: (raw['skillsDir'] as string[] | undefined) ?? [],
      addDirs: (raw['addDir'] as string[] | undefined) ?? [],
    };

    onMain(opts);
  });

  return program;
}
