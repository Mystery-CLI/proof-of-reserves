# Proof-of-Reserves on Stellar

A zero-knowledge proof system that lets a stablecoin issuer prove their reserves cover all user liabilities — without revealing any individual account balance.

Built for the **Real-World ZK on Stellar** hackathon (June 2026).

---

## Live Demo

**Deployed contract**: [`CDKOGVGTG7ODIPJ37KA5LQSUEQM63RIOSROVVBG7K34SBVQWOAIMKB4U`](https://stellar.expert/explorer/testnet/contract/CDKOGVGTG7ODIPJ37KA5LQSUEQM63RIOSROVVBG7K34SBVQWOAIMKB4U)  
**Network**: Stellar Testnet (Protocol 26)

---

## What It Does

A stablecoin issuer holds funds for thousands of customers. The public wants to know: *"Are they actually solvent?"* But publishing every customer's balance would violate privacy.

This project solves that with ZK:

1. The issuer runs a **ZK proof** that takes private account balances as input and outputs only the total — without revealing any individual balance
2. The proof is verified by a **Soroban smart contract** on Stellar using native BN254 elliptic curve operations (Protocol 25/26)
3. The contract checks that the issuer's public reserve account covers the total, then records a **SOLVENT** or **INSOLVENT** verdict permanently on-chain

No auditor needed. No trust required. Math does it.

---

## ZK Stack

| Layer | Tool |
|---|---|
| Circuit | Circom 2 |
| Proof system | Groth16 (snarkjs) |
| On-chain verifier | Soroban smart contract (Rust) |
| Elliptic curve | BN254 (Stellar Protocol 25/26 host functions) |
| Network | Stellar Testnet |

---

## Project Structure

```
proof-of-reserves/
├── circuits/
│   └── reserves.circom          # ZK circuit: proves sum of balances = total liabilities
├── scripts/
│   ├── generate_proof.js        # Generates a Groth16 proof from private balances
│   ├── deploy.js                # Deploys the Soroban contract to testnet
│   ├── verify_on_chain.js       # CLI tool to call verify_solvency directly
│   ├── server.js                # Backend API + static server for the demo UI
│   └── vk_to_rust.js            # Converts verification key JSON to Rust byte arrays
├── keys/
│   ├── reserves_js/reserves.wasm  # Compiled circuit (witness generator)
│   ├── reserves_final.zkey         # Proving key
│   ├── verification_key.json       # Verification key
│   └── proof.json                  # Most recent generated proof
├── contract/
│   └── contracts/proof-of-reserves/src/
│       ├── lib.rs               # Soroban verifier contract (Groth16 + solvency check)
│       └── vk.rs                # Auto-generated VK byte arrays (from vk_to_rust.js)
└── frontend/
    └── index.html               # Demo UI — served by server.js
```

---

## How to Run

### Prerequisites

- Node.js 18+
- Rust + `wasm32v1-none` target (for rebuilding the contract)

### Setup

Copy the example env file and fill in your credentials:

```bash
cp .env.example .env
# Edit .env and set DEPLOYER_SECRET and CONTRACT_ID
```

```bash
npm install
```

### 1. Run the Demo

```bash
npm start
```

Open `http://localhost:8080` in your browser.

> **Codespaces**: The devcontainer starts the server automatically on port 8080 every time the Codespace starts — no manual step needed.

Use the reserve balance slider:
- Set reserve **above** $10,000 → contract returns **SOLVENT ✓**
- Set reserve **below** $10,000 → contract returns **INSOLVENT ✗**

Each click submits the pre-generated ZK proof to the deployed Stellar testnet contract and links to the transaction on Stellar Expert.

### 2. Generate a New ZK Proof (optional)

```bash
node scripts/generate_proof.js
```

This takes 5 private account balances (hardcoded in the script), proves their sum equals the total liabilities without revealing any individual balance, and writes `keys/proof.json`.

### 3. Rebuild the Contract (optional)

The WASM is already compiled and the contract is deployed. To rebuild from source:

```bash
cd contract
cargo build --target wasm32v1-none --release -p proof-of-reserves
```

Requires Rust with `rustup target add wasm32v1-none`.

### 4. Redeploy (optional)

```bash
node scripts/deploy.js
```

Deploys to testnet using the key in `keys/deployer_key.json`. Writes the new contract ID to `keys/contract_id.txt`.

---

## How the ZK Proof Works

The Circom circuit (`circuits/reserves.circom`) proves two things about the private inputs:
1. Every balance is **non-negative** (64-bit range check via `Num2Bits`)
2. The **sum of all balances** equals the claimed public `totalLiabilities`

The Soroban contract verifies this using the Groth16 pairing equation:

```
e(-A, B) · e(alpha, beta) · e(vk_x, gamma) · e(C, delta) == 1
```

Where `vk_x = IC[0] + totalLiabilities · IC[1]` is computed on-chain using BN254 host functions native to Stellar (introduced in Protocol 25, extended in Protocol 26).

If the proof checks out AND `reserveBalance >= totalLiabilities`, the contract stamps **SOLVENT** on the ledger.

---

## Known Limitations

- Currently supports exactly 5 accounts (circuit hardcoded to N=5)
- The verification key is passed as a call parameter — in production it should be hardcoded at deploy time or stored in contract storage during initialization
- The demo uses a pre-generated proof with fixed private balances (mock data); a production system would generate proofs dynamically from real balances
- Not audited — do not use with real assets
- Testnet only

---

## Hackathon

**Event**: Real-World ZK on Stellar  
**Deadline**: June 29, 2026  
**Prize pool**: $10,000 in XLM
