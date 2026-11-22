import { cp, mkdir, readFile, readdir, readlink, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const plugin = process.argv[2] || "codex";
const supportedPlatforms = {
  codex: ["macos-arm64", "macos-x64", "windows-x64", "linux-x64"],
  dot: ["macos-arm64", "macos-x64"],
};
const platform = process.env.PRISM_PLATFORM;
if (!Object.prototype.hasOwnProperty.call(supportedPlatforms, plugin) || !supportedPlatforms[plugin].includes(platform)) {
  throw new Error("unsupported plugin or release platform");
}
const source = plugin === "dot" ? resolve(root, "dot") : root;
const manifest = await readFile(resolve(source, "pluginbridge-plugin.yaml"), "utf8");
const id = manifest.match(/^id:\s*(.+)$/m)?.[1]?.trim();
const version = manifest.match(/^version:\s*(.+)$/m)?.[1]?.trim();
if (id !== plugin || !/^\d+\.\d+\.\d+$/.test(version || "")) throw new Error("invalid release manifest identity");
const destination = resolve(root, "release", `${id}-${version}-${platform}`);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
const modules = plugin === "dot"
  ? ["index.cjs", "adapter.cjs", "delivery-ledger.cjs", "desktop.cjs", "navigation.cjs", "stdio.cjs", "surface.cjs"]
  : ["index.js", "codex_cdp.js", "question_surface.js", "windows_sqlite.js"];
for (const entry of [...modules, "node_modules", "package.json", "package-lock.json", "pluginbridge-plugin.yaml", "README.md"]) {
  await cp(resolve(source, entry), resolve(destination, entry), { recursive: true, verbatimSymlinks: true });
}
await mkdir(resolve(destination, "shared"));
await cp(resolve(root, "shared/desktop-host.cjs"), resolve(destination, "shared/desktop-host.cjs"));
await cp(resolve(root, "LICENSE"), resolve(destination, "LICENSE"));

async function assertSelfContainedSymlinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await readlink(path);
      const fromRoot = relative(destination, resolve(dirname(path), target));
      if (isAbsolute(target) || isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
        throw new Error(`发布归档不能引用归档外路径: ${path} -> ${target}`);
      }
      continue;
    }
    if (entry.isDirectory()) await assertSelfContainedSymlinks(path);
  }
}

await assertSelfContainedSymlinks(destination);
console.log(destination);
