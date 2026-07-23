/**
 * Probe #5 — find which serialization the tx actually uses for the 2-element
 * accepts list, and whether its length differs from the correct 149. No gas.
 *
 * Run: npx tsx scripts/sdk-clvalue-probe.ts
 */
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const sdk = req('casper-js-sdk');
const { CLValue, CLValueParser } = sdk;

function opt(asset: string, amount: number, dec: number, sym: string, name: string, ver: string) {
  return CLValue.newCLTuple2(
    CLValue.newCLTuple3(CLValue.newCLString(asset), CLValue.newCLUInt512(amount), CLValue.newCLUint8(dec)),
    CLValue.newCLTuple3(CLValue.newCLString(sym), CLValue.newCLString(name), CLValue.newCLString(ver)),
  );
}
const one = [opt('native', 2_500_000_000, 9, 'CSPR', 'CSPR', '')];
const two = [
  opt('native', 2_500_000_000, 9, 'CSPR', 'CSPR', ''),
  opt('hash-3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e', 100_000_000, 9, 'WCSPR', 'Wrapped CSPR', '1'),
];

function dump(label: string, clv: any) {
  console.log(`\n== ${label} ==`);
  console.log('instance methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(clv)).filter((n) => /byte|serial|toJSON|toBytes/i.test(n)));
  for (const m of ['bytes', 'toBytes', 'bytesWithType', 'toBytesWithType']) {
    try {
      const b = clv[m]?.();
      if (b) console.log(`  .${m}() len=${b.length} hex=${Buffer.from(b).toString('hex').slice(0, 60)}…`);
    } catch (e: any) { console.log(`  .${m}() ERR ${e.message}`); }
  }
  for (const m of ['toBytesWithType', 'toBytes']) {
    try {
      const b = CLValueParser?.[m]?.(clv);
      if (b) console.log(`  CLValueParser.${m}() len=${b.length} hex=${Buffer.from(b).toString('hex').slice(0, 60)}…`);
    } catch (e: any) { console.log(`  CLValueParser.${m}() ERR ${e.message}`); }
  }
}

const list1 = CLValue.newCLList(one[0].type, one);
const list2 = CLValue.newCLList(two[0].type, two);
dump('1-element list (works on-chain)', list1);
dump('2-element list (fails LeftOverBytes)', list2);
