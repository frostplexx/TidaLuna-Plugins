import { type BuildOptions } from "esbuild";

import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

import { listen, pluginBuildOptions } from "luna/build";

try {
	process.loadEnvFile();
} catch {}

const creds = {
	RL_ACCESS_TOKEN_ID: process.env.RL_ACCESS_TOKEN_ID ?? "",
	RL_ACCESS_TOKEN: process.env.RL_ACCESS_TOKEN ?? "",
};
const missing = Object.keys(creds).filter((key) => !creds[key as keyof typeof creds]);
if (missing.length) {
	const msg = `Missing ${missing.join(", ")} (set in .env or env), Radiant Lyrics API calls will fail`;
	// No creds = no release
	if (process.env.CI) throw new Error(msg);
	console.warn(msg);
}
const define = Object.fromEntries(
	Object.entries(creds).map(([key, value]) => [`__${key}__`, JSON.stringify(value)]),
);

const pluginFolders = await readdir(join(process.cwd(), "./plugins"));
const buildConfigs: BuildOptions[] = await Promise.all(
	pluginFolders.map((name) => pluginBuildOptions(`./plugins/${name}`, { define })),
);

listen(buildConfigs);

// Quick export of plugins for store functionality
const pkg = JSON.parse(await readFile(join(process.cwd(), "./package.json"), "utf8"));
pkg.plugins ??= buildConfigs.map((config) => config.outfile?.replace("./dist/", ""));
await mkdir(join(process.cwd(), "./dist"), { recursive: true });
await writeFile(join(process.cwd(), "./dist/store.json"), JSON.stringify(pkg));
