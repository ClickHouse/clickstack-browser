import { defineConfig, type Rolldown } from "tsdown";
import pkg from "./package.json" with { type: "json" };

const define = { __CLICKSTACK_VERSION__: JSON.stringify(pkg.version) };

// Rolldown appends a sourceMappingURL comment to each .d.ts chunk even though no .d.ts.map is
// written, so editors would look for maps that are not in the package.
const dropDanglingDtsMapComment: Rolldown.Plugin = {
  name: "clickstack:drop-dangling-dts-map-comment",
  generateBundle(_options, bundle) {
    for (const file of Object.values(bundle)) {
      if (file.type === "chunk" && file.fileName.endsWith(".d.ts")) {
        file.code = file.code.replace(
          /\n\/\/# sourceMappingURL=\S+\.d\.ts\.map\s*$/,
          "\n",
        );
      }
    }
  },
};

// The script-tag build contains these projects' code, and their licenses require the notices in
// every copy. Minification drops the upstream license comments, so the notices are the banner,
// which tsdown adds after minification.
const notices = `/*! ${pkg.name} ${pkg.version} | ${pkg.license}
 *
 * Bundled third-party code:
 * - OpenTelemetry JS, Apache-2.0, Copyright The OpenTelemetry Authors
 * - web-vitals, Apache-2.0, Copyright 2020 Google LLC
 * - rrweb, MIT, Copyright (c) 2018 Contributors (https://github.com/rrweb-io/rrweb/graphs/contributors)
 * - base64-arraybuffer, MIT, Copyright (c) 2012 Niklas von Hertzen
 *
 * Apache-2.0: https://www.apache.org/licenses/LICENSE-2.0
 *
 * MIT: Permission is hereby granted, free of charge, to any person obtaining a copy of this
 * software and associated documentation files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 * BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */`;

export default defineConfig([
  {
    entry: { index: "src/index.ts", replay: "src/replay.ts" },
    format: "esm",
    platform: "browser",
    target: "es2022",
    dts: true,
    sourcemap: true,
    // Otherwise the chunk both entries share is named after one of its modules, with a hash.
    hash: false,
    outputOptions: { chunkFileNames: "shared.js" },
    define,
    plugins: [dropDanglingDtsMapComment],
    failOnWarn: true,
  },
  {
    entry: { clickstack: "src/iife.ts" },
    format: "iife",
    globalName: "ClickStack",
    // Makes Rolldown honor the "browser" field that the @opentelemetry packages use.
    platform: "browser",
    target: "es2022",
    minify: true,
    sourcemap: true,
    dts: false,
    define,
    // Script-tag users have no bundler, so the file carries every dependency, peers included.
    deps: { alwaysBundle: [/./] },
    outputOptions: { codeSplitting: false },
    banner: notices,
    failOnWarn: true,
  },
]);
