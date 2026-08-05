import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { node: true, console: true, process: true }
    },
    ignores: ["node_modules/**", "dist/**", "build/**", "tools/.cache/**"]
  }
];
