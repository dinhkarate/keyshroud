// tsc rewrites relative `.ts` specifiers in emitted JS but not in .d.ts files;
// point declarations at their `.js` siblings so every TypeScript consumer resolves them.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

for (const file of readdirSync("dist")) {
  if (!file.endsWith(".d.ts")) continue;
  const path = `dist/${file}`;
  writeFileSync(path, readFileSync(path, "utf8").replace(/(from "\.\/[^"]+)\.ts"/g, '$1.js"'));
}
