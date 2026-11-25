import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifacts = resolve(root, process.argv[2] || "release-artifacts");
const plugin = process.argv[3] || "codex";
if (!["codex", "dot"].includes(plugin)) throw new Error("unsupported plugin");
const manifest = await readFile(resolve(root, plugin === "dot" ? "dot/pluginbridge-plugin.yaml" : "pluginbridge-plugin.yaml"), "utf8");
const get = (name) => manifest.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim().replace(/^(?:"|')|(?:"|')$/g, "");
const id = get("id"), version = get("version");
const displayName = get("display_name"), description = get("description");
const iconURL = get("icon_url"), iconSVGURL = get("icon_svg_url");
const protocolVersion = get("plugin_protocol_version"), minHubVersion = get("min_hub_version");
if (id !== plugin || !/^\d+\.\d+\.\d+$/.test(version || "") || protocolVersion !== "4" || !minHubVersion) {
  throw new Error("invalid release manifest identity");
}
const platforms = plugin === "dot" ? ["macos-arm64", "macos-x64"] : ["macos-arm64", "macos-x64", "windows-x64", "linux-x64"];
const names = (await readdir(artifacts)).filter((name) => name.endsWith(".tar.gz")).sort();
if (names.length !== platforms.length) throw new Error(`expected ${platforms.length} platform archives, found ${names.length}`);
const assets = await Promise.all(platforms.map(async (platform) => {
  const filename = `${id}-${version}-${platform}.tar.gz`;
  const bytes = await readFile(resolve(artifacts, filename));
  if (!bytes.length) throw new Error(`empty platform archive: ${filename}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { platform, filename, sha256, size_bytes: bytes.length };
}));
const metadata = {
  schema_version: 1,
  plugin_id: id,
  version,
  display_name: displayName,
  description,
  icon_url: iconURL,
  icon_svg_url: iconSVGURL,
  channel: "stable",
  plugin_protocol_version: protocolVersion,
  min_hub_version: minHubVersion,
  supported_platforms: platforms,
  assets
};
await writeFile(resolve(artifacts, "plugin-release.json"), JSON.stringify(metadata, null, 2) + "\n");
