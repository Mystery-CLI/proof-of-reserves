/**
 * server.js — Backend API + frontend server for the Proof-of-Reserves demo.
 * Usage: node scripts/server.js
 * Serves frontend at http://localhost:8080
 *
 * POST /api/fetch-balances  { addresses: string[5] }
 *   → { balances: string[5], total: string }  (all values in stroops)
 *
 * POST /api/generate-proof  { balances: string[5] }
 *   → { proof, publicSignals, totalLiabilities: string }
 *
 * POST /api/submit-proof    { proof, totalLiabilities: string, reserveBalance: string }
 *   → { isSolvent: bool, txHash: string }
 *
 * POST /api/verify  { reserveBalance: number }   (legacy fallback, pre-generated proof)
 */

require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const express    = require("express");
const cors       = require("cors");
const path       = require("path");
const fs         = require("fs");
const snarkjs    = require("snarkjs");
const StellarSdk = require("@stellar/stellar-sdk");

const HORIZON_URL        = "https://horizon-testnet.stellar.org";
const RPC_URL            = "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = StellarSdk.Networks.TESTNET;

function loadSecret() {
  if (process.env.DEPLOYER_SECRET) return process.env.DEPLOYER_SECRET;
  const keyFile = path.join(__dirname, "../keys/deployer_key.json");
  if (fs.existsSync(keyFile)) return JSON.parse(fs.readFileSync(keyFile)).secret;
  throw new Error("No deployer secret found. Set DEPLOYER_SECRET in .env or provide keys/deployer_key.json");
}

function loadContractId() {
  if (process.env.CONTRACT_ID) return process.env.CONTRACT_ID;
  const idFile = path.join(__dirname, "../keys/contract_id.txt");
  if (fs.existsSync(idFile)) return fs.readFileSync(idFile, "utf8").trim();
  throw new Error("No contract ID found. Set CONTRACT_ID in .env or provide keys/contract_id.txt");
}

const CONTRACT_ID = loadContractId();
const KEYPAIR     = StellarSdk.Keypair.fromSecret(loadSecret());

const proofPath = path.join(__dirname, "../keys/proof.json");
const PROOF_FALLBACK = fs.existsSync(proofPath) ? JSON.parse(fs.readFileSync(proofPath)) : null;

const vkPath = path.join(__dirname, "../keys/verification_key.json");
const VK_DATA = process.env.VERIFICATION_KEY
  ? JSON.parse(Buffer.from(process.env.VERIFICATION_KEY, "base64").toString())
  : JSON.parse(fs.readFileSync(vkPath));

const WASM_PATH = path.join(__dirname, "../keys/reserves_js/reserves.wasm");
const ZKEY_PATH = path.join(__dirname, "../keys/reserves_final.zkey");

// ── Horizon helpers ───────────────────────────────────────────────────────────

function xlmToStroops(xlmStr) {
  const [intPart, decPart = ""] = xlmStr.split(".");
  const padded = decPart.padEnd(7, "0").slice(0, 7);
  return BigInt(intPart) * 10_000_000n + BigInt(padded);
}

async function fetchXlmBalance(address) {
  const resp = await fetch(`${HORIZON_URL}/accounts/${address}`);
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(`${address.slice(0, 8)}…: ${body.title || resp.statusText}`);
  }
  const data = await resp.json();
  const native = data.balances.find(b => b.asset_type === "native");
  if (!native) throw new Error(`No XLM balance for ${address.slice(0, 8)}…`);
  return xlmToStroops(native.balance);
}

// ── ZK proof generation ───────────────────────────────────────────────────────

async function generateProof(balancesBig) {
  const input = { balances: balancesBig.map(b => b.toString()) };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM_PATH, ZKEY_PATH);
  return { proof, publicSignals };
}

// ── Stellar encoding helpers ──────────────────────────────────────────────────

function bigIntTo32Bytes(n) {
  const hex = BigInt(n).toString(16).padStart(64, "0");
  const buf = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) buf[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return buf;
}
function encodeG1(x, y) { return Buffer.concat([bigIntTo32Bytes(x), bigIntTo32Bytes(y)]); }
function encodeG2(pt) {
  return Buffer.concat([
    bigIntTo32Bytes(pt[0][1]), bigIntTo32Bytes(pt[0][0]),
    bigIntTo32Bytes(pt[1][1]), bigIntTo32Bytes(pt[1][0]),
  ]);
}
function bytesVal(buf) { return StellarSdk.xdr.ScVal.scvBytes(buf); }
function mapVal(entries) {
  const sorted = [...entries].sort((a, b) => a[0].localeCompare(b[0]));
  return StellarSdk.xdr.ScVal.scvMap(
    sorted.map(([k, v]) => new StellarSdk.xdr.ScMapEntry({
      key: StellarSdk.xdr.ScVal.scvSymbol(k), val: v
    }))
  );
}
function i128Val(n) {
  const big = BigInt(n);
  return StellarSdk.xdr.ScVal.scvI128(new StellarSdk.xdr.Int128Parts({
    lo: StellarSdk.xdr.Uint64.fromString((big & 0xFFFFFFFFFFFFFFFFn).toString()),
    hi: StellarSdk.xdr.Int64.fromString((big >> 64n).toString()),
  }));
}
function buildProofArg(p) {
  return mapVal([
    ["a", bytesVal(encodeG1(p.proof.pi_a[0], p.proof.pi_a[1]))],
    ["b", bytesVal(encodeG2(p.proof.pi_b))],
    ["c", bytesVal(encodeG1(p.proof.pi_c[0], p.proof.pi_c[1]))],
  ]);
}
function buildVKArg(vk) {
  return mapVal([
    ["alpha", bytesVal(encodeG1(vk.vk_alpha_1[0], vk.vk_alpha_1[1]))],
    ["beta",  bytesVal(encodeG2(vk.vk_beta_2))],
    ["gamma", bytesVal(encodeG2(vk.vk_gamma_2))],
    ["delta", bytesVal(encodeG2(vk.vk_delta_2))],
    ["ic0",   bytesVal(encodeG1(vk.IC[0][0], vk.IC[0][1]))],
    ["ic1",   bytesVal(encodeG1(vk.IC[1][0], vk.IC[1][1]))],
  ]);
}

// ── Stellar contract call ─────────────────────────────────────────────────────

async function verifySolvency(proofData, totalLiabilities, reserveBalance) {
  const server   = new StellarSdk.rpc.Server(RPC_URL);
  const account  = await server.getAccount(KEYPAIR.publicKey());
  const contract = new StellarSdk.Contract(CONTRACT_ID);

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "10000000", networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(
      "verify_solvency",
      buildProofArg(proofData),
      buildVKArg(VK_DATA),
      i128Val(totalLiabilities),
      i128Val(reserveBalance),
    ))
    .setTimeout(300)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new Error("Simulation failed: " + sim.error);
  }
  const prepared = StellarSdk.rpc.assembleTransaction(tx, sim).build();
  prepared.sign(KEYPAIR);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error("Send failed");

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const result = await server.getTransaction(sent.hash);
    if (result.status === "SUCCESS") {
      const rv = result.returnValue;
      const isSolvent = rv?.switch?.()?.name === "scvBool" ? rv.b() : Boolean(rv?.b?.());
      return { isSolvent, txHash: sent.hash };
    }
    if (result.status === "FAILED") throw new Error("Transaction failed");
  }
  throw new Error("Transaction timed out");
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

// Fetch live XLM balances for 5 Stellar addresses via Horizon
app.post("/api/fetch-balances", async (req, res) => {
  const { addresses } = req.body;
  if (!Array.isArray(addresses) || addresses.length !== 5) {
    return res.status(400).json({ error: "Need exactly 5 Stellar addresses" });
  }
  console.log("[fetch-balances]", addresses.map(a => a.slice(0, 8) + "…").join(", "));
  try {
    const balances = await Promise.all(addresses.map(fetchXlmBalance));
    const total = balances.reduce((a, b) => a + b, 0n);
    console.log("[fetch-balances] total:", total.toString(), "stroops =",
      (Number(total) / 1e7).toFixed(7), "XLM");
    res.json({ balances: balances.map(b => b.toString()), total: total.toString() });
  } catch (err) {
    console.error("[fetch-balances] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generate a Groth16 ZK proof from 5 balances (in stroops)
app.post("/api/generate-proof", async (req, res) => {
  const { balances: rawBalances } = req.body;
  if (!Array.isArray(rawBalances) || rawBalances.length !== 5) {
    return res.status(400).json({ error: "Need exactly 5 balances" });
  }
  const balancesBig = rawBalances.map(b => BigInt(b));
  const totalLiabilities = balancesBig.reduce((a, b) => a + b, 0n);
  console.log("[generate-proof] total:", totalLiabilities.toString(), "stroops");
  try {
    const proofData = await generateProof(balancesBig);
    console.log("[generate-proof] done, publicSignals:", proofData.publicSignals);
    res.json({ proof: proofData.proof, publicSignals: proofData.publicSignals,
               totalLiabilities: totalLiabilities.toString() });
  } catch (err) {
    console.error("[generate-proof] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Submit a generated proof to the Stellar contract and wait for confirmation
app.post("/api/submit-proof", async (req, res) => {
  const { proof, totalLiabilities, reserveBalance } = req.body;
  if (!proof || !totalLiabilities || reserveBalance === undefined) {
    return res.status(400).json({ error: "Missing proof, totalLiabilities, or reserveBalance" });
  }
  const totalBig   = BigInt(totalLiabilities);
  const reserveBig = BigInt(reserveBalance);
  console.log(`[submit-proof] total=${totalBig} reserve=${reserveBig}`);
  try {
    const result = await verifySolvency({ proof }, totalBig, reserveBig);
    console.log(`[submit-proof] ${result.isSolvent ? "SOLVENT" : "INSOLVENT"} tx=${result.txHash}`);
    res.json(result);
  } catch (err) {
    console.error("[submit-proof] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Fetch live XLM balance for a single reserve account address
app.post("/api/fetch-reserve", async (req, res) => {
  const { address } = req.body;
  if (!address || typeof address !== "string") {
    return res.status(400).json({ error: "Need a Stellar address" });
  }
  console.log("[fetch-reserve]", address.slice(0, 8) + "…");
  try {
    const balance = await fetchXlmBalance(address);
    console.log("[fetch-reserve] balance:", balance.toString(), "stroops");
    res.json({ balance: balance.toString() });
  } catch (err) {
    console.error("[fetch-reserve] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Legacy: single-shot verify with pre-generated proof (used by the default demo)
app.post("/api/verify", async (req, res) => {
  if (!PROOF_FALLBACK) {
    return res.status(503).json({ error: "Legacy proof not available on this deployment." });
  }
  const reserveBalance = parseInt(req.body.reserveBalance ?? 1200000, 10);
  if (isNaN(reserveBalance) || reserveBalance < 0) {
    return res.status(400).json({ error: "Invalid reserveBalance" });
  }
  console.log(`[verify] legacy mode, reserveBalance=${reserveBalance}`);
  try {
    const result = await verifySolvency(PROOF_FALLBACK, BigInt(1000000), BigInt(reserveBalance));
    console.log(`[verify] ${result.isSolvent ? "SOLVENT" : "INSOLVENT"} tx=${result.txHash}`);
    res.json(result);
  } catch (err) {
    console.error("[verify] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log("Contract:", CONTRACT_ID);
  console.log("Deployer:", KEYPAIR.publicKey());
});
