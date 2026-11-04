// Usage: bun scripts/build-bridge.ts   (run from the repo root)
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const targets = ['bun-windows-x64', 'bun-darwin-arm64', 'bun-darwin-x64', 'bun-linux-x64', 'bun-linux-arm64'];

let failed = 0;
for (const t of targets) {
  const out = path.join(root, 'dist', `herdr-bridge-${t}${t.includes('windows') ? '.exe' : ''}`);
  console.log(`==> ${t}`);
  const p = Bun.spawnSync(
    ['bun', 'build', path.join(root, 'bridge', 'src', 'cli.ts'), '--compile', `--target=${t}`, '--outfile', out],
    { cwd: root, stdout: 'inherit', stderr: 'inherit' },
  );
  if (p.exitCode !== 0) {
    console.error(`FAILED: ${t}`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
