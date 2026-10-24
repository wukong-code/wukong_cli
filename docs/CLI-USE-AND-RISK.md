# Wukong CLI Use and Risk Notice

This notice explains the risks and responsibilities of using the Wukong CLI. It
supplements the [MIT License](../LICENSE); it does not replace, narrow, or add
conditions to the MIT License for the software.

## Use at Your Own Risk

You are solely responsible for deciding whether to run Wukong and for everything
that happens after you approve an action. Wukong may read and modify files, run
commands, invoke repository scripts, call model providers, and interact with
plugins, MCP servers, hooks, dependencies, and other tools.

Before running it, keep appropriate backups and version control, review the
workspace and repository, protect secrets, and grant only permissions you can
afford to grant. Review the proposed command, working directory, diff, output,
network request, and resulting files before relying on them.

## Execution Boundary

The CLI runs approved commands with the permissions of your operating-system
user. It is not a complete shell sandbox, malware detector, security scanner, or
production approval system. Exact command and working-directory displays do not
certify child processes, shell scripts, PATH-resolved programs, hooks, plugins,
MCP servers, dependencies, or generated code.

Do not run untrusted code or connect untrusted tools in an environment containing
production credentials or sensitive data unless you have independently designed
and verified the required isolation.

## AI Output and Gate Results

Model output may be wrong, incomplete, stale, insecure, biased, or unsuitable for
your environment. It may contain unsafe commands, defective code, licensing
issues, or invented explanations. You must test and independently review every
result.

`PASS` means only that the configured checks and review produced that result for
the recorded run. It is not a guarantee of correctness, security, absence of
defects, legal or regulatory compliance, production readiness, or fitness for a
particular purpose. `NEEDS_WORK` and `ERROR` also require your judgment.

Wukong is not legal, financial, medical, security, or compliance advice. Do not
use its output as the sole basis for a decision that could materially affect a
person or organization.

## Providers and Third Parties

You choose the model provider and are responsible for its fees, terms, privacy
practices, retention, and permitted use. Do not send source code, secrets,
personal data, or confidential information to a provider unless you are
authorized to do so.

You are responsible for reviewing the licenses, security, and permissions of
models, plugins, MCP servers, packages, prompts, generated code, and external
repositories. Third-party services and outputs are controlled by their providers;
Wukong does not guarantee their availability, security, or accuracy.

## Prohibited Use

Do not use Wukong to violate law or another person's rights; access systems,
accounts, data, or networks without authorization; steal credentials; deploy
malware; damage systems; evade security controls; or submit protected data
without the required authorization.

## Disclaimer

To the maximum extent permitted by law, Wukong and its contributors provide the
CLI and its output without warranties and are not responsible for loss caused by
your use of the CLI, model output, commands, providers, plugins, MCP servers,
dependencies, generated code, or data loss. The MIT License contains the
controlling warranty disclaimer and liability terms for the software.

For the website, account, feedback, and hosted services, see the separate
[Website Terms of Service](https://wukong.today/terms). Those services are not
required for ordinary local BYOK use.
