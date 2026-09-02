// `preview/build.ts` reads `import.meta.url` to locate `preview/out/` relative to
// its own file. TypeScript's built-in `ImportMeta` interface is empty by default;
// this augments it with just the one property actually used, without pulling in
// `@types/node` project-wide (see `node-shims.d.ts` for why that's avoided).
export {};

declare global {
  interface ImportMeta {
    url: string;
  }
}
