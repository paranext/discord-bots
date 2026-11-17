/**
 * Minimal ambient types for the Node built-ins `preview/build.ts` and the
 * fixture-recording guard in `tests/core/fixtures.test.ts` import.
 *
 * `@types/node` is not a dependency of this project (the Worker runtime types
 * from `@cloudflare/workers-types` cover `src/`), and adding it to `tsconfig.json`'s
 * global `types` array would pull Node's ambient globals into every file typechecked
 * by this single project-wide config, including the Worker code — risking exactly
 * the kind of global/Worker type collision that config was set up to avoid. This
 * file lives under `preview/` but, being a plain ambient declaration file with no
 * imports or exports, its module augmentations apply program-wide once tsc's
 * single `include` picks it up — so it also covers the handful of Node calls the
 * test file above needs, rather than duplicating the same shim a second time.
 *
 * This must stay a plain ambient script (no top-level import/export): a shorthand
 * `declare module "..."` is only global when the file itself has no imports or
 * exports. See `import-meta.d.ts` for the `import.meta.url` augmentation, which
 * needs the opposite (a module, for `declare global` to apply) and so cannot live
 * in this same file.
 *
 * This file is picked up project-wide because it lives inside the shared
 * tsconfig's `include`, not because anything under `src/` imports it. Its
 * Node shims are deliberately minimal — only the specific exports the two
 * files above actually call. A future `src/` file that reaches for
 * `node:fs` or another Node built-in will get whatever truncated surface
 * happens to be declared here (or a silent `any`), not a clear "no
 * `@types/node`" error. If that happens, the right fix is real `@types/node`
 * scoped to wherever needs it, not widening this shim.
 */
declare module "node:fs" {
  export function existsSync(path: string): boolean;
}

declare module "node:fs/promises" {
  export function mkdir(path: URL, options?: { recursive?: boolean }): Promise<string | undefined>;
  export function writeFile(path: URL, data: string, encoding: string): Promise<void>;
  export function readFile(path: string, encoding: string): Promise<string>;
}

declare module "node:process" {
  export function cwd(): string;
}

declare module "node:url" {
  export function pathToFileURL(path: string): URL;
  export function fileURLToPath(url: URL | string): string;
}
