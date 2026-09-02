/**
 * Minimal ambient types for the Node built-ins `preview/build.ts` imports.
 *
 * `@types/node` is not a dependency of this project (the Worker runtime types
 * from `@cloudflare/workers-types` cover `src/`), and adding it to `tsconfig.json`'s
 * global `types` array would pull Node's ambient globals into every file typechecked
 * by this single project-wide config, including the Worker code — risking exactly
 * the kind of global/Worker type collision that config was set up to avoid. Scoping
 * a tiny shim to only what `preview/` actually calls keeps that boundary intact.
 *
 * This must stay a plain ambient script (no top-level import/export): a shorthand
 * `declare module "..."` is only global when the file itself has no imports or
 * exports. See `import-meta.d.ts` for the `import.meta.url` augmentation, which
 * needs the opposite (a module, for `declare global` to apply) and so cannot live
 * in this same file.
 */
declare module "node:fs/promises" {
  export function mkdir(path: URL, options?: { recursive?: boolean }): Promise<string | undefined>;
  export function writeFile(path: URL, data: string, encoding: string): Promise<void>;
}

declare module "node:process" {
  export function cwd(): string;
}

declare module "node:url" {
  export function pathToFileURL(path: string): URL;
}
