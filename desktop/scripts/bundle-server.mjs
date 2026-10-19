// Prepares desktop/server-bundle: server sources + production node_modules with better-sqlite3 built
// for Electron's ABI and the target platform. Usage: node scripts/bundle-server.mjs [--platform win32] [--arch x64]
// (platform/arch are only used to verify that a native SQLite binary exists for the target.)
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const platform = arg('platform', process.platform);
const arch = arg('arch', process.arch);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.resolve(here, '..', '..');
// Nested one level (server-bundle/server): electron-builder strips a top-level node_modules from extraResources.
const out = path.resolve(here, '..', 'server-bundle', 'server');
fs.rmSync(path.dirname(out), { recursive: true, force: true });
const run = (cmd, cwd) => { console.log(`> ${cmd}`); execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, npm_config_workspaces: 'false' } }); };

if (!fs.existsSync(path.join(root, 'web', 'dist', 'index.html'))) run('npm run build -w web', root);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(root, 'server', 'src'), path.join(out, 'src'), { recursive: true });
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'server', 'package.json'), 'utf8'));
delete pkg.devDependencies;
pkg.scripts = { start: 'node src/index.js' };
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify(pkg, null, 2));

run('npm install --omit=dev --no-package-lock --no-audit --no-fund --workspaces=false --ignore-scripts', out);
// better-sqlite3 ships Node-API prebuilds for every OS inside the package; they load in Electron as-is,
// so the bundle is platform independent. Verify the target binary is present.
const prebuilt = path.join(out, 'node_modules', 'better-sqlite3', 'prebuilds', `${platform}-${arch}.node`);
if (!fs.existsSync(prebuilt)) throw new Error(`better-sqlite3 has no prebuilt binary for ${platform}-${arch} (${prebuilt})`);
// Prune binaries for other platforms and the SQLite sources to keep the installer small.
const bs = path.join(out, 'node_modules', 'better-sqlite3');
for (const f of fs.readdirSync(path.join(bs, 'prebuilds'))) if (f !== `${platform}-${arch}.node`) fs.rmSync(path.join(bs, 'prebuilds', f));
for (const d of ['deps', 'src', 'build']) fs.rmSync(path.join(bs, d), { recursive: true, force: true });
console.log(`Server bundle ready (${platform}-${arch}) at ${out}`);
