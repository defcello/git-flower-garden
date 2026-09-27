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
    // Plain JavaScript config files are outside the TypeScript project.
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
