/**
 * deploy.js — Deploy the Proof-of-Reserves contract to Stellar testnet.
 * Usage: node scripts/deploy.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const StellarSdk = require("@stellar/stellar-sdk");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const https = require("https");

const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;
const WASM_PATH = path.join(__dirname, "../contract/target/wasm32v1-none/release/proof_of_reserves.wasm");

async function wait(server, hash, label) {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const r = await server.getTransaction(hash);
    if (r.status === "SUCCESS") return r;
    if (r.status === "FAILED") throw new Error(`${label} TX failed: ${JSON.stringify(r.resultXdr)}`);
  }
  throw new Error(`${label} TX timed out`);
}

async function friendbot(address) {
  return new Promise((resolve, reject) => {
    https.get(`https://friendbot.stellar.org?addr=${address}`, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { console.log("Friendbot:", JSON.parse(d).detail || "ok"); resolve(); });
    }).on("error", reject);
  });
}

async function main() {
  const server = new StellarSdk.rpc.Server(RPC_URL);

  // Load or generate keypair — prefer DEPLOYER_SECRET env var, then key file
  const KEY_FILE = path.join(__dirname, "../keys/deployer_key.json");
  let keypair;
  if (process.env.DEPLOYER_SECRET) {
    keypair = StellarSdk.Keypair.fromSecret(process.env.DEPLOYER_SECRET);
    console.log("Deployer (from env):", keypair.publicKey());
  } else if (fs.existsSync(KEY_FILE)) {
    keypair = StellarSdk.Keypair.fromSecret(JSON.parse(fs.readFileSync(KEY_FILE)).secret);
    console.log("Deployer (from file):", keypair.publicKey());
  } else {
    keypair = StellarSdk.Keypair.random();
    fs.writeFileSync(KEY_FILE, JSON.stringify({ secret: keypair.secret(), public: keypair.publicKey() }));
    console.log("New deployer (generated):", keypair.publicKey());
  }

  // Fund
  await friendbot(keypair.publicKey());

  // Load WASM and compute hash (SHA-256 of WASM bytes)
  const wasmBytes = fs.readFileSync(WASM_PATH);
  const wasmHash = crypto.createHash("sha256").update(wasmBytes).digest();
  console.log(`WASM: ${wasmBytes.length} bytes, hash: ${wasmHash.toString("hex").slice(0, 16)}...`);

  // --- Step 1: Upload WASM ---
  console.log("Uploading WASM...");
  let account = await server.getAccount(keypair.publicKey());
  const uploadTx = new StellarSdk.TransactionBuilder(account, {
    fee: "1000000", networkPassphrase: NETWORK_PASSPHRASE
  })
    .addOperation(StellarSdk.Operation.uploadContractWasm({ wasm: wasmBytes }))
    .setTimeout(300)
    .build();

  const simUp = await server.simulateTransaction(uploadTx);
  if (StellarSdk.rpc.Api.isSimulationError(simUp)) throw new Error("Upload sim failed: " + simUp.error);
  const prepUp = StellarSdk.rpc.assembleTransaction(uploadTx, simUp).build();
  prepUp.sign(keypair);
  const upResult = await server.sendTransaction(prepUp);
  if (upResult.status === "ERROR") throw new Error("Upload send error: " + upResult.errorResult);
  console.log("Upload TX:", upResult.hash);
  await wait(server, upResult.hash, "Upload");
  console.log("WASM uploaded ✓");

  // --- Step 2: Deploy contract instance ---
  console.log("Deploying contract instance...");
  account = await server.getAccount(keypair.publicKey());
  const deployTx = new StellarSdk.TransactionBuilder(account, {
    fee: "1000000", networkPassphrase: NETWORK_PASSPHRASE
  })
    .addOperation(StellarSdk.Operation.createCustomContract({
      address: new StellarSdk.Address(keypair.publicKey()),
      wasmHash: wasmHash,
      salt: Buffer.alloc(32),
    }))
    .setTimeout(300)
    .build();

  const simDep = await server.simulateTransaction(deployTx);
  if (StellarSdk.rpc.Api.isSimulationError(simDep)) throw new Error("Deploy sim failed: " + simDep.error);
  const prepDep = StellarSdk.rpc.assembleTransaction(deployTx, simDep).build();
  prepDep.sign(keypair);
  const depResult = await server.sendTransaction(prepDep);
  if (depResult.status === "ERROR") throw new Error("Deploy send error: " + depResult.errorResult);
  console.log("Deploy TX:", depResult.hash);
  const depConfirm = await wait(server, depResult.hash, "Deploy");

  // Extract contract ID from return value
  let contractId;
  try {
    const meta = depConfirm.resultMetaXdr;
    const scVal = StellarSdk.xdr.TransactionMeta.fromXDR(meta, "base64").v3().sorobanMeta().returnValue();
    contractId = StellarSdk.Address.fromScVal(scVal).toString();
  } catch (e) {
    // Fallback: look in the ledger changes for the new contract
    console.log("Could not extract from return value, checking simulation result...");
    const retVal = simDep.result?.retval;
    if (retVal) {
      contractId = StellarSdk.Address.fromScVal(retVal).toString();
    } else {
      throw new Error("Could not determine contract ID: " + e.message);
    }
  }

  console.log("\n✓ Contract deployed!");
  console.log("Contract ID:", contractId);
  console.log("TX:", depResult.hash);
  console.log("Explorer: https://stellar.expert/explorer/testnet/tx/" + depResult.hash);

  fs.writeFileSync(path.join(__dirname, "../frontend/contract_id.txt"), contractId);
  fs.writeFileSync(path.join(__dirname, "../keys/contract_id.txt"), contractId);
  console.log("Saved to frontend/contract_id.txt");
}

main().catch(err => { console.error("Deploy failed:", err.message); process.exit(1); });
