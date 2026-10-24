# Third-Party Notices

Wukong CLI is distributed under the MIT License. The repository also includes
open-source packages and build inputs from third parties, each under its own
license. The authoritative dependency versions and integrity hashes are pinned
in `pnpm-lock.yaml` and the Nix inputs are pinned in `flake.lock`.

Before each release, the release workflow must generate and attach a complete
machine-readable dependency inventory and license report for the npm package and
native artifacts. This checked-in file records the policy boundary; generated
release reports are the authoritative version-specific inventory.

## First-party license

Wukong CLI source and first-party packages are licensed under the MIT License in
[`LICENSE`](LICENSE).

## Upstream base

Portions of the CLI, TUI, and agent foundation derive from
[Kimi Code](https://github.com/MoonshotAI/kimi-code) (MIT). Its original
license notice is retained below as required by the MIT License:

```text
MIT License

Copyright (c) 2026 Moonshot AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Third-party license policy

- Do not add a dependency whose license cannot be identified from package
  metadata or its upstream source.
- Preserve upstream copyright and license notices in distributed packages.
- Review license changes as part of dependency updates.
- Do not treat this file as replacing the license text shipped by a dependency.

For a release-specific dependency inventory, download the SBOM and generated
license report attached to that release. If those assets are missing, report a
release-process issue before redistributing the artifact.
