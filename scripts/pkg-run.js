import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Detects the package manager based on lockfiles and executes the given script.
 */

const rootDir = process.cwd();
const script = process.argv[2];
const args = process.argv.slice(3);

function getPkgManager() {
  if (existsSync(join(rootDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(rootDir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

const pkgManager = getPkgManager();
console.log(`> Detected ${pkgManager}. Running: ${pkgManager} run ${script} ${args.join(' ')}`);

const result = spawnSync(pkgManager, ['run', script, ...args], {
  stdio: 'inherit',
  shell: true
});

process.exit(result.status ?? 0);
