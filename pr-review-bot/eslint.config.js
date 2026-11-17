import tseslint from "typescript-eslint";

export default tseslint.config(
  // `.preview-build` and `.script-build` are `tsc --outDir` targets for the
  // `preview` and `register-commands` scripts: emitted JavaScript, ignored here
  // for the same reason. Without `.script-build`, `npm run lint` exits 1 with 36
  // errors on generated code the moment anyone registers commands locally.
  { ignores: ["node_modules", "preview/out", ".preview-build", ".script-build", "coverage", ".wrangler"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "Date", message: "core/ takes time as an argument; adapters use Date.now() explicitly." },
      ],
    },
  },
  { files: ["src/index.ts", "src/handlers/**", "src/store/**", "src/discord/**", "src/github/**", "preview/**", "tests/**"], rules: { "no-restricted-globals": "off" } },
);
