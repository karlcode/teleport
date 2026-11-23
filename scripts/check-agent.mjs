// The gate on what runs on the device: ES5 syntax (es-check) and a gzip size budget, for the agent
// (every page pays for it) and for the inspector (paid when DevTools opens or a trial runs).
// ES5 *built-ins* are enforced separately by the ESLint step of `npm run check` (eslint-plugin-es-x) and
// `tsc -p packages/agent` (ES5 lib), because es-check only parses syntax.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const BUDGET = 15 * 1024;
/** The inspector's: about 2.5 KB over what it is, so growth is a decision someone makes. */
const INSPECTOR_BUDGET = 22 * 1024;
const files = ['packages/agent/dist/teleport.min.js', 'packages/agent/dist/teleport.js', 'packages/agent/dist/agent.cjs', 'packages/inspector/dist/inspector.js'];

for (const f of files) {
  if (!existsSync(root + f)) {
    console.error(`check:agent: ${f} missing, run \`npm run build\` first`);
    process.exit(1);
  }
}

execFileSync('npx', ['es-check', 'es5', ...files, '--quiet'], { cwd: root, stdio: 'inherit' });

const size = (f) => {
  const bytes = readFileSync(root + f);
  return { min: bytes.length, gz: gzipSync(bytes, { level: 9 }).length };
};
// The budget holds for both forms the agent ships in: the script tag and the bundled @tlpt/agent.
const tag = size(files[0]);
const bundled = size('packages/agent/dist/agent.cjs');
const insp = size('packages/inspector/dist/inspector.js');
const gz = Math.max(tag.gz, bundled.gz);
const pct = ((100 * gz) / BUDGET).toFixed(1);
console.log(`check:agent: es5 ok; teleport.min.js ${tag.min} B min, ${tag.gz} B min+gzip; agent.cjs ${bundled.min} B min, ${bundled.gz} B min+gzip (${pct}% of ${BUDGET} B budget)`);
console.log(`check:agent: inspector.js ${insp.min} B min, ${insp.gz} B min+gzip (${((100 * insp.gz) / INSPECTOR_BUDGET).toFixed(1)}% of ${INSPECTOR_BUDGET} B budget; loaded only while DevTools or a trial needs it)`);
if (gz > BUDGET) {
  console.error(`check:agent: FAIL, the agent is over budget by ${gz - BUDGET} B`);
  process.exit(1);
}
if (insp.gz > INSPECTOR_BUDGET) {
  console.error(`check:agent: FAIL, the inspector is over budget by ${insp.gz - INSPECTOR_BUDGET} B`);
  process.exit(1);
}
