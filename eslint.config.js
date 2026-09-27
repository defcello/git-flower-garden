import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/",
      "release/",
      "coverage/",
      "node_modules/",
      "tmp/",
      "playwright-report/",
      "test-results/",
      // Reviewed third-party code, pinned as a submodule (ADR 0019).
      "vendor/",
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["src/ui/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
  },
  {
    // Only the wrapper may import astronomy-engine: some of its functions
    // never return on a non-finite number (ADR 0019).
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/environment/astronomy.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "#astronomy-engine",
              message: "Use src/environment/astronomy.ts (ADR 0019).",
            },
          ],
        },
      ],
    },
  },
  {
    // Plain JavaScript config files are outside the TypeScript project.
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
