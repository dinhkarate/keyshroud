// Single source of product naming. Renaming the project only touches this file,
// package.json, and documentation.
export const BRAND = {
  name: "keyshroud",
  bin: "keyshroud",
  envPrefix: "KEYSHROUD",
  configDirName: "keyshroud",
  // Scheme of a local vault reference (keyshroud://Item); local:// is still read.
  refScheme: "keyshroud",
} as const;
