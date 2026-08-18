import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  collectSourceFiles,
  compareBaseline,
  extractSpecifiers,
  main,
  resolveSpecifier,
  scanViolations,
  toPosixPath,
} from "./check-agent-core-boundaries.mjs";

function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "wukong-boundaries-"));
  const srcDir = join(root, "packages/agent-core/src");
  mkdirSync(srcDir, { recursive: true });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  return {
    root,
    srcDir,
    write(relativePath, content = "export {};\n") {
      const path = join(srcDir, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    },
  };
}

void test("extracts TypeScript module specifiers without reading comments", () => {
  const source = `
    // import { ignored } from "../comment-only/private";
    import {
      /* don't lose the real import */ value,
    } from "../session/private";
    export { config } from "../config/private";
    import "../profile/register";
    import Adapter = require("../plugin/adapter");
    const commonjs = require("../tools/commonjs");
    const lazy = import(\`../logging/private\`);
    type Rpc = import("../rpc/private").Rpc;
  `;

  assert.deepEqual(extractSpecifiers(source), [
    "../session/private",
    "../config/private",
    "../profile/register",
    "../plugin/adapter",
    "../tools/commonjs",
    "../logging/private",
    "../rpc/private",
  ]);
});

void test("ignores calls to a locally shadowed require binding", () => {
  const source = `
    const commonjs = require("../tools/commonjs");
    function load(require) {
      return require("../session/private");
    }
  `;

  assert.deepEqual(extractSpecifiers(source, "source.cts"), ["../tools/commonjs"]);
});

void test("recognizes createRequire and ambient CommonJS loader bindings", () => {
  const source = `
    import { createRequire as makeRequire } from "node:module";
    const localRequire = makeRequire(import.meta.url);
    localRequire("../session/private");
  `;
  const namespaceSource = `
    import * as nodeModule from "node:module";
    const loader = nodeModule.createRequire(import.meta.url);
    loader("../config/private");
  `;
  const ambientSource = `
    declare const require: (specifier: string) => unknown;
    require("../rpc/private");
  `;

  assert.deepEqual(extractSpecifiers(source, "source.cts"), [
    "node:module",
    "../session/private",
  ]);
  assert.deepEqual(extractSpecifiers(namespaceSource, "namespace.cts"), [
    "node:module",
    "../config/private",
  ]);
  assert.deepEqual(extractSpecifiers(ambientSource, "ambient.cts"), ["../rpc/private"]);
});

void test("does not confuse a shadowed createRequire factory with node:module", () => {
  const source = `
    import { createRequire as makeRequire } from "node:module";
    function load(makeRequire) {
      const require = makeRequire("not-a-loader");
      return require("../session/private");
    }
  `;

  assert.deepEqual(extractSpecifiers(source, "source.cts"), ["node:module"]);
});

void test("resolves package self-references to agent-core source files", (t) => {
  const fixture = createFixture(t);
  fixture.write("session/provider-manager.ts");

  assert.equal(
    resolveSpecifier(
      fixture.srcDir,
      "loop/run-turn.ts",
      "@wukong/agent-core/session/provider-manager"
    ),
    "session/provider-manager.ts"
  );
});

void test("scans TSX sources and targets, dynamic imports, and ignores comments", (t) => {
  const fixture = createFixture(t);
  fixture.write("session/private.tsx");
  fixture.write("session/comment-only.ts");
  fixture.write(
    "loop/view.tsx",
    `
      // import { ignored } from "@wukong/agent-core/session/comment-only";
      import { privateValue } from "@wukong/agent-core/session/private";
      export const view = privateValue;
    `
  );
  fixture.write(
    "loop/lazy.ts",
    "export const lazy = import(`../session/private`);\n"
  );
  fixture.write(
    "loop/commonjs.cts",
    "module.exports = require('../session/private');\n"
  );

  const result = scanViolations({
    srcDir: fixture.srcDir,
    srcRel: "packages/agent-core/src",
  });

  assert.deepEqual(collectSourceFiles(fixture.srcDir).toSorted(), [
    "loop/commonjs.cts",
    "loop/lazy.ts",
    "loop/view.tsx",
    "session/comment-only.ts",
    "session/private.tsx",
  ]);
  assert.deepEqual([...result.current].toSorted(), [
    "packages/agent-core/src/loop/commonjs.cts: ../session/private",
    "packages/agent-core/src/loop/lazy.ts: ../session/private",
    "packages/agent-core/src/loop/view.tsx: @wukong/agent-core/session/private",
  ]);
});

void test("normalizes Windows separators before module classification", () => {
  assert.equal(toPosixPath("agent\\turn\\index.ts"), "agent/turn/index.ts");
});

void test("resolves Windows-style relative CommonJS specifiers", (t) => {
  const fixture = createFixture(t);
  fixture.write("session/provider-manager.ts");

  assert.equal(
    resolveSpecifier(
      fixture.srcDir,
      "loop/run-turn.cts",
      "..\\session\\provider-manager"
    ),
    "session/provider-manager.ts"
  );
});

void test("reports stale baseline entries separately from new violations", () => {
  assert.deepEqual(
    compareBaseline(new Set(["kept", "new"]), ["kept", "stale"]),
    {
      newViolations: ["new"],
      stale: ["stale"],
    }
  );
});

void test("fails on stale entries and preserves --update regeneration", (t) => {
  const fixture = createFixture(t);
  fixture.write("loop/index.ts");
  fixture.write("session/index.ts");
  const baselinePath = join(fixture.root, "baseline.json");
  writeFileSync(baselinePath, '["stale violation"]\n');
  const logger = { log() {}, error() {} };
  const options = {
    srcDir: fixture.srcDir,
    srcRel: "packages/agent-core/src",
    baselinePath,
    logger,
  };

  assert.equal(main([], options), 1);
  assert.equal(main(["--update"], options), 0);
  assert.deepEqual(JSON.parse(readFileSync(baselinePath, "utf8")), []);
});

void test("refuses to add new violations through --update", (t) => {
  const fixture = createFixture(t);
  fixture.write("session/private.ts");
  fixture.write("loop/run.ts", 'import "../session/private";\n');
  const baselinePath = join(fixture.root, "baseline.json");
  writeFileSync(baselinePath, "[]\n");
  const logger = { log() {}, error() {} };

  assert.equal(
    main(["--update"], {
      srcDir: fixture.srcDir,
      srcRel: "packages/agent-core/src",
      baselinePath,
      logger,
    }),
    1
  );
  assert.deepEqual(JSON.parse(readFileSync(baselinePath, "utf8")), []);
});
