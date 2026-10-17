import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import js from "@eslint/js";
import baseline from "eslint-plugin-baseline-js";
import tsdoc from "eslint-plugin-tsdoc";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

const sharedExtends = [
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  comments.recommended,
];

/** @type {import('eslint').Linter.RulesRecord} */
const sharedRules = {
  "@eslint-community/eslint-comments/require-description": "error",
  "@eslint-community/eslint-comments/no-unused-disable": "error",
};

const baselinePlugin = { meta: baseline.meta, rules: baseline.rules };

export default defineConfig([
  globalIgnores(["coverage/", "dist/", "pack/", "test-results/"]),
  {
    files: ["src/**/*.ts"],
    extends: sharedExtends,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { tsdoc, "baseline-js": baselinePlugin },
    rules: {
      ...sharedRules,
      ...baseline.configs["recommended-ts"]({
        available: "widely",
        level: "error",
      }).rules,
      "tsdoc/syntax": "error",
      "no-console": "error",
    },
  },
  {
    files: ["*.config.{js,ts}", "e2e/**/*.{mjs,ts}"],
    extends: sharedExtends,
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: "./tsconfig.node.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...sharedRules,
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            {
              from: "package",
              package: "node:test",
              name: ["describe", "test", "suite", "it"],
            },
          ],
        },
      ],
    },
  },
]);
