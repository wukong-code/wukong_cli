{
  description = "Wukong CLI";

  inputs = {
    # Pinned to the 25.11 release channel because nixpkgs-unstable currently
    # ships nodejs_24 = 24.14.1, which trips the >= 24.15.0 floor that the
    # native SEA build enforces (see apps/wukong/scripts/native/build.mjs).
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
  };

  outputs =
    { self, nixpkgs }:
    let
      lib = nixpkgs.lib;

      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];

      forAllSystems =
        f:
        lib.genAttrs systems (
          system:
          f (import nixpkgs {
            inherit system;
          })
        );

      minNodeVersion = "24.15.0";

      # Hardcode to Node.js 24.x; fail the evaluation if the pinned nixpkgs
      # does not offer a new enough 24.x.
      nodejsFor =
        pkgs:
        let
          node = pkgs.nodejs_24;
        in
        if lib.versionAtLeast node.version minNodeVersion then
          node
        else
          throw ''
            Wukong requires Node.js >= ${minNodeVersion},
            but nixpkgs only offers ${node.version}.
            Pin a newer nixpkgs revision or update minNodeVersion in flake.nix.
          '';

      pnpmFor =
        pkgs:
        pkgs.pnpm_10.override {
          nodejs = nodejsFor pkgs;
        };

      # -------------------------------------------------------------------
      # Workspace members (kept in sync with pnpm-workspace.yaml).
      #
      # HARD REQUIREMENT: whenever you add or remove a workspace package,
      # you MUST update both lists below. Missing a path will break the Nix
      # build (src fileset silently drops files); missing a name will break
      # pnpmConfigHook (dependencies for that workspace won't be fetched).
      # -------------------------------------------------------------------
      workspacePaths = [
        ./packages/acp-adapter
        ./packages/agent-core
        ./packages/build-support
        ./packages/server
        ./packages/server-e2e
        ./packages/kaos
        ./packages/kosong
        ./packages/migration-legacy
        ./packages/node-sdk
        ./packages/oauth
        ./packages/protocol
        ./packages/telemetry
        ./packages/verification
        ./apps/wukong
        ./apps/wukong-web
        ./apps/vis
        ./apps/vis/server
        ./apps/vis/web
        ./docs
      ];

      workspaceNames = [
        "@wukong/acp-adapter"
        "@wukong/agent-core"
        "@wukong/build-support"
        "@wukong/server"
        "@wukong/server-e2e"
        "@wukong/kaos"
        "@wukong/kosong"
        "@wukong/migration-legacy"
        "@wukong/wukong-sdk"
        "@wukong/wukong-oauth"
        "@wukong/protocol"
        "@wukong/wukong-telemetry"
        "@wukong/verification"
        "@wukong.today/code"
        "@wukong/wukong-web"
        "@wukong/vis"
        "@wukong/vis-server"
        "@wukong/vis-web"
        "wukong-docs"
      ];
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          nodejs = nodejsFor pkgs;
          pnpm = pnpmFor pkgs;
          appPackageJson = builtins.fromJSON (builtins.readFile ./apps/wukong/package.json);

          wukong = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "wukong";
            version = appPackageJson.version;

            src = lib.fileset.toSource {
              root = ./.;
              fileset = lib.fileset.unions (
                [
                  ./build
                  ./.npmrc
                  ./.nvmrc
                  ./package.json
                  ./pnpm-lock.yaml
                  ./pnpm-workspace.yaml
                  ./tsconfig.json
                  ./vitest.config.ts
                  ./LICENSE
                ]
                ++ workspacePaths
              );
            };

            pnpmWorkspaces = [ "." ] ++ workspaceNames;

            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version src pnpmWorkspaces;
              inherit pnpm;
              fetcherVersion = 3;
              hash = "sha256-RBPVapxGHaX/xcBIE+ZPLA58L79lnA8O/y7BZzGHjo8=";
            };

            nativeBuildInputs = [
              nodejs
              pnpm
              (pkgs.pnpmConfigHook.override { inherit pnpm; })
              pkgs.makeWrapper
            ];

            buildPhase = ''
              runHook preBuild
              pnpm --filter=@wukong.today/code run build
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              mkdir -p $out/lib/wukong
              cp -r apps/wukong/dist apps/wukong/dist-web $out/lib/wukong/

              makeWrapper ${nodejs}/bin/node $out/bin/wukong \
                --add-flags $out/lib/wukong/dist/main.mjs \
                --prefix PATH : ${lib.makeBinPath [ pkgs.ripgrep pkgs.fd ]}

              runHook postInstall
            '';

            meta = {
              description = "Wukong CLI";
              homepage = "https://github.com/WukongAI/wukong";
              license = lib.licenses.mit;
              mainProgram = "wukong";
              platforms = systems;
            };
          });
        in
        {
          inherit wukong;
          default = wukong;
        }
      );

      apps = forAllSystems (pkgs: {
        wukong = {
          type = "app";
          program = "${self.packages.${pkgs.system}.wukong}/bin/wukong";
        };
        default = self.apps.${pkgs.system}.wukong;
      });

      devShells = forAllSystems (pkgs: {
        default =
          let
            nodejs = nodejsFor pkgs;
            pnpm = pnpmFor pkgs;
          in
          pkgs.mkShell {
            packages = [
              nodejs
              pnpm
              pkgs.ripgrep
              pkgs.fd
            ];
          };
      });
    };
}
