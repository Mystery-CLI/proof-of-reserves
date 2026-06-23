/**
 * verify_on_chain.js — Call verify_solvency on the deployed Stellar contract.
 * Usage: node scripts/verify_on_chain.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const StellarSdk = require("@stellar/stellar-sdk");
const fs = require("fs");
const path = require("path");

const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;

// Proof data (from keys/proof.json)
const proof = JSON.parse(fs.readFileSync(path.join(__dirname, "../keys/proof.json")));
const vkJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../keys/verification_key.json")));
const contractId = fs.readFileSync(path.join(__dirname, "../keys/contract_id.txt"), "utf8").trim();

const TOTAL_LIABILITIES = BigInt(1000000);  // $10,000.00
const RESERVE_BALANCE   = BigInt(1200000);  // $12,000.00

// ── Encoding helpers ──────────────────────────────────────────────────────────

function bigIntTo32Bytes(n) {
  const hex = BigInt(n).toString(16).padStart(64, "0");
  const arr = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return arr;
}

function encodeG1(x, y) {
  return Buffer.concat([bigIntTo32Bytes(x), bigIntTo32Bytes(y)]);
}

// G2 point: Soroban format = X.c1 || X.c0 || Y.c1 || Y.c0
function encodeG2(point) {
  return Buffer.concat([
    bigIntTo32Bytes(point[0][1]),  // X.c1
    bigIntTo32Bytes(point[0][0]),  // X.c0
    bigIntTo32Bytes(point[1][1]),  // Y.c1
    bigIntTo32Bytes(point[1][0]),  // Y.c0
  ]);
}

function bytesVal(buf) {
  return StellarSdk.xdr.ScVal.scvBytes(buf);
}

function mapVal(entries) {
  const sorted = [...entries].sort((a, b) => a[0].localeCompare(b[0]));
  return StellarSdk.xdr.ScVal.scvMap(
    sorted.map(([k, v]) => new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.xdr.ScVal.scvSymbol(k),
      val: v
    }))
  );
}

function i128Val(n) {
  const big = BigInt(n);
  const lo = big & 0xFFFFFFFFFFFFFFFFn;
  const hi = big >> 64n;
  return StellarSdk.xdr.ScVal.scvI128(
    new StellarSdk.xdr.Int128Parts({
      lo: StellarSdk.xdr.Uint64.fromString(lo.toString()),
      hi: StellarSdk.xdr.Int64.fromString(hi.toString())
    })
  );
}

function encodeProof(p) {
  return mapVal([
    ["a", bytesVal(encodeG1(p.proof.pi_a[0], p.proof.pi_a[1]))],
    ["b", bytesVal(encodeG2(p.proof.pi_b))],
    ["c", bytesVal(encodeG1(p.proof.pi_c[0], p.proof.pi_c[1]))]
  ]);
}

function encodeVK(vk) {
  return mapVal([
    ["alpha", bytesVal(encodeG1(vk.vk_alpha_1[0], vk.vk_alpha_1[1]))],
    ["beta",  bytesVal(encodeG2(vk.vk_beta_2))],
    ["gamma", bytesVal(encodeG2(vk.vk_gamma_2))],
    ["delta", bytesVal(encodeG2(vk.vk_delta_2))],
    ["ic0",   bytesVal(encodeG1(vk.IC[0][0], vk.IC[0][1]))],
    ["ic1",   bytesVal(encodeG1(vk.IC[1][0], vk.IC[1][1]))]
  ]);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const server = new StellarSdk.rpc.Server(RPC_URL);

  // Load deployer keypair from env or key file
  const KEY_FILE = path.join(__dirname, "../keys/deployer_key.json");
  const secret = process.env.DEPLOYER_SECRET
    || JSON.parse(fs.readFileSync(KEY_FILE)).secret;
  const keypair = StellarSdk.Keypair.fromSecret(secret);
  console.log("Caller:", keypair.publicKey());
  console.log("Contract:", contractId);
  console.log("");

  const proofArg = encodeProof(proof);
  const vkArg    = encodeVK(vkJson);
  const tlArg    = i128Val(TOTAL_LIABILITIES);
  const rbArg    = i128Val(RESERVE_BALANCE);

  const account = await server.getAccount(keypair.publicKey());
  const contract = new StellarSdk.Contract(contractId);

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "10000000",
    networkPassphrase: NETWORK_PASSPHRASE
  })
    .addOperation(contract.call("verify_solvency", proofArg, vkArg, tlArg, rbArg))
    .setTimeout(300)
    .build();

  console.log("Simulating...");
  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new Error("Simulation failed: " + sim.error);
  }
  console.log("Simulation OK. Cost:", sim.minResourceFee, "stroops");

  console.log("Submitting...");
  const prepared = StellarSdk.rpc.assembleTransaction(tx, sim).build();
  prepared.sign(keypair);
  const sendResult = await server.sendTransaction(prepared);
  if (sendResult.status === "ERROR") throw new Error("Send error: " + sendResult.errorResult);
  console.log("TX hash:", sendResult.hash);

  // Wait for confirmation
  let result;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    result = await server.getTransaction(sendResult.hash);
    if (result.status === "SUCCESS" || result.status === "FAILED") break;
  }

  if (result.status === "FAILED") {
    console.error("TX FAILED:", result.resultXdr);
    return;
  }

  // Parse return value — newer SDK exposes returnValue directly
  const isSolvent = result.returnValue?.b?.() ?? result.returnValue?._value ?? false;

  console.log("\n═══════════════════════════════════════");
  console.log(isSolvent ? "SOLVENT ✓  — Proof verified on-chain!" : "INSOLVENT ✗ — Verification failed");
  console.log("═══════════════════════════════════════");
  console.log("Total liabilities: $" + (Number(TOTAL_LIABILITIES) / 100).toFixed(2));
  console.log("Reserve balance:   $" + (Number(RESERVE_BALANCE) / 100).toFixed(2));
  console.log("");
  console.log("Stellar Expert: https://stellar.expert/explorer/testnet/tx/" + sendResult.hash);
}

main().catch(err => { console.error("Failed:", err.message); process.exit(1); });
