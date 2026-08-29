/**
 * Print the AppSec exclusions document Rudder would serve for a given host and
 * rule list, so it can be checked against a real CrowdSec.
 *
 *   bun --preload ./test/preload.ts scripts/print-appsec-config.ts \
 *     app.example.com 942100 tag:attack-lfi
 */
import { generateAppsecConfig } from '../src/lib/server/appsec';

const [host, ...rules] = process.argv.slice(2);
if (!host) {
  console.error('usage: print-appsec-config.ts <host> <rule>...');
  process.exit(1);
}

process.stdout.write(
  generateAppsecConfig([
    { host, rules: rules.map((r) => (/^\d+$/.test(r) ? Number(r) : r)) },
  ]),
);
