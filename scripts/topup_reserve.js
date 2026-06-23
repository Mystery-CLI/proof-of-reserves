/**
 * topup_reserve.js — Merge temp testnet accounts into the reserve account.
 *
 * Usage:
 *   TEMP_KEYS='["S...","S..."]' RESERVE=G... node scripts/topup_reserve.js
 *
 * Or create keys/temp_accounts.json (gitignored) with:
 *   { "reserve": "G...", "secrets": ["S...", "S...", ...] }
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const StellarSdk = require("@stellar/stellar-sdk");
const fs         = require("fs");
const path       = require("path");

const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK = StellarSdk.Networks.TESTNET;

function loadConfig() {
  // Prefer env vars
  if (process.env.TEMP_KEYS && process.env.RESERVE) {
    return { reserve: process.env.RESERVE, secrets: JSON.parse(process.env.TEMP_KEYS) };
  }
  // Fall back to gitignored config file
  const cfgPath = path.join(__dirname, "../keys/temp_accounts.json");
  if (fs.existsSync(cfgPath)) {
    return JSON.parse(fs.readFileSync(cfgPath));
  }
  throw new Error(
    "No temp account config found.\n" +
    "Set TEMP_KEYS and RESERVE env vars, or create keys/temp_accounts.json:\n" +
    '  { "reserve": "G...", "secrets": ["S...", ...] }'
  );
}

async function merge(secretKey, reserve) {
  const kp = StellarSdk.Keypair.fromSecret(secretKey);
  const server = new StellarSdk.rpc.Server(RPC_URL);
  const account = await server.getAccount(kp.publicKey());
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "100000", networkPassphrase: NETWORK,
  })
    .addOperation(StellarSdk.Operation.accountMerge({ destination: reserve }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(JSON.stringify(sent));
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const r = await server.getTransaction(sent.hash);
    if (r.status === "SUCCESS") return sent.hash;
    if (r.status === "FAILED") throw new Error("tx failed");
  }
  throw new Error("timeout");
}

async function main() {
  const { reserve, secrets } = loadConfig();
  console.log(`Merging ${secrets.length} account(s) into reserve: ${reserve.slice(0, 8)}…`);

  for (const sec of secrets) {
    const pub = StellarSdk.Keypair.fromSecret(sec).publicKey();
    process.stdout.write(`  Merging ${pub.slice(0, 8)}… → reserve... `);
    const hash = await merge(sec, reserve);
    console.log("✓", hash.slice(0, 12));
  }

  const resp = await fetch("https://horizon-testnet.stellar.org/accounts/" + reserve);
  const data = await resp.json();
  const bal  = data.balances.find(b => b.asset_type === "native").balance;
  console.log("\nReserve balance:", bal, "XLM ✓");
}

main().catch(e => { console.error(e.message); process.exit(1); });
