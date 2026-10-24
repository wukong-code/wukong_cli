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

## Third-party license policy

- Do not add a dependency whose license cannot be identified from package
  metadata or its upstream source.
- Preserve upstream copyright and license notices in distributed packages.
- Review license changes as part of dependency updates.
- Do not treat this file as replacing the license text shipped by a dependency.

For a release-specific dependency inventory, download the SBOM and generated
license report attached to that release. If those assets are missing, report a
release-process issue before redistributing the artifact.
