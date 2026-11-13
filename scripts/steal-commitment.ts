/**
 * Prints the Strategy commitment(s) to register on the dashboard
 * (My Agents → Edit agent → Steal the VFY). Reads STRATEGY_PARAMS / STRATEGY_SALT
 * (and the _PREVIOUS pair) from the environment; never prints them.
 *
 *   npm run steal:commitment          # reads .env
 */
import { commitmentHex, loadKeyring } from '../src/steal/keyring.js';

try {
  const keyring = loadKeyring(process.env);
  if (!keyring.current) throw new Error('STRATEGY_PARAMS and STRATEGY_SALT are not set');
  console.log(`current  ${commitmentHex(keyring.current)}`);
  if (keyring.previous) console.log(`previous ${commitmentHex(keyring.previous)}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
