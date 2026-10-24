# Security Policy

## Supported Versions

Security fixes are provided for the latest stable `0.1.x` release. The current
stable release is `v0.1.2`; older releases may not receive security updates.

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅ Yes     |
| < 0.1   | ❌ No      |

## Reporting a Vulnerability

Please do not open a public issue or discussion for a security vulnerability.
Report it privately to [security@wukong.today](mailto:security@wukong.today).
If GitHub Private Vulnerability Reporting is enabled for this repository, you may
also use its Security Advisories reporting form. Do not include production
credentials or customer data in a report.

Include, when available:

- Affected version (output of `wukong --version`)
- Reproduction steps or a proof of concept
- Potential impact and affected component (CLI, installer, plugin/MCP boundary, or release artifact)
- Any suggested mitigation
- CWE/CVE reference, if known

This policy covers the open-source local CLI and its published build artifacts.
The website, account services, and operations backend are separate private
systems and are not covered by this repository's MIT license or this policy.

## Our Response

We will acknowledge receipt within 48 hours and provide an initial assessment
within 7 days. We will coordinate a fix, release advisory, and disclosure
schedule with the reporter. Third-party dependency issues are in scope when
they affect a published Wukong package or artifact; upstream-only issues should
also be reported to the upstream maintainer.
