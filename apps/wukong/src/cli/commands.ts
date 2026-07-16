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
import { registerLoopCommand } from './sub/loop';
import { registerProofCommand } from './sub/proof';
import { registerProviderCommand } from './sub/provider';
import { registerReportUploadCommand } from './sub/report-upload';
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
    .option('-y, --yolo', 'Automatically approve all actions.', false)
    .option('--auto', 'Start in auto permission mode.', false)
    .addOption(
      new Option(
        '-m, --model <model>',
        'LLM model alias to use for this invocation. Defaults to default_model in config.toml.',
      ),
    )
    .addOption(
      new Option('--role <role>', 'Transform the agent for this invocation (for example: security).'),
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
    const every = loop.minIntervalMs === undefined ? '' : ` --every ${String(loop.minIntervalMs / 1_000)}s`;
    onMain({
      session: undefined,
      continue: false,
      yolo: false,
      auto: false,
      plan: false,
      model: loop.model ?? raw['model'] as string | undefined,
      role: loop.role ?? raw['role'] as string | undefined,
      outputFormat: raw['outputFormat'] as CLIOptions['outputFormat'],
      prompt: `/loop --max-iterations ${String(loop.maxIterations)}${every} -- ${loop.objective ?? ''}`,
      skillsDirs: raw['skillsDir'] as string[],
      addDirs: raw['addDir'] as string[],
    });
  });
  registerGuardCommand(program);
  registerLoginCommand(program);
  registerReportUploadCommand(program);
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
    const yoloValue = raw['yolo'] === true || raw['yes'] === true || raw['autoApprove'] === true;
    const autoValue = raw['auto'] === true;

    const opts: CLIOptions = {
      session: sessionValue,
      continue: raw['continue'] === true || raw['C'] === true,
      yolo: yoloValue,
      auto: autoValue,
      plan: raw['plan'] as boolean,
      model: raw['model'] as string | undefined,
      role: raw['role'] as string | undefined,
      outputFormat: raw['outputFormat'] as CLIOptions['outputFormat'],
      prompt: raw['prompt'] as string | undefined,
      skillsDirs: raw['skillsDir'] as string[],
      addDirs: raw['addDir'] as string[],
    };

    onMain(opts);
  });

  return program;
}
