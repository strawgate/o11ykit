import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "**/dist/**",
      "**/dist-test/**",
      "**/lib/**",
      "**/node_modules/**",
      ".work/**",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "eqeqeq": ["error", "always"],
      "no-throw-literal": "error",
      "prefer-const": "error",
      "no-var": "error",
    },
  },
);
