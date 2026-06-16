# Proof-of-Reserves on Stellar

A zero-knowledge proof system that lets a stablecoin issuer prove their reserves cover all user liabilities — without revealing any individual account balance.

Built for the **Real-World ZK on Stellar** hackathon (June 2026).

---

## What It Does

A stablecoin issuer holds funds for thousands of customers. The public wants to know: *"Are they actually solvent?"* But publishing every customer's balance would violate privacy.

This project solves that with ZK:

1. The issuer runs a **ZK proof** that takes private account balances as input and outputs only the total — without revealing any individual balance
2. The proof is verified by a **Soroban smart contract** on Stellar using native BN254 elliptic curve operations (Protocol 25/26)
3. The contract checks that the issuer's public reserve account covers the total, then records a **SOLVENT** or **INSOLVENT** verdict on-chain

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
│   └── reserves.circom          # ZK circuit: proves sum of balances = total
├── scripts/
│   ├── generate_proof.js        # Generates a Groth16 proof from private balances
│   └── vk_to_rust.js            # Converts verification key to Rust byte arrays
├── keys/
│   ├── reserves_js/reserves.wasm  # Compiled circuit (witness generator)
│   ├── reserves_final.zkey         # Proving key
│   └── verification_key.json       # Verification key (used by contract)
├── contract/
│   └── src/lib.rs               # Soroban verifier contract
└── frontend/
    └── index.html               # Demo UI
```

---

## How to Run

### 1. Generate a ZK Proof

```bash
npm install
node scripts/generate_proof.js
```

This takes 5 private account balances, proves their sum without revealing individuals, and outputs `keys/proof.json`.

### 2. Build the Contract

```bash
cd contract
stellar contract build
```

### 3. Deploy to Testnet

```bash
stellar keys generate --global deployer --network testnet
curl "https://friendbot.stellar.org?addr=$(stellar keys address deployer)"

stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/proof_of_reserves.wasm \
  --source deployer \
  --network testnet
```

### 4. Verify On-Chain

Call `verify_solvency` on the deployed contract with the proof, verification key, total liabilities, and reserve balance. The contract returns `true` (solvent) or `false` and records the result permanently on-chain.

---

## How the ZK Proof Works

The Circom circuit proves two things about the private inputs:
1. Every balance is **non-negative** (64-bit range check)
2. The **sum of all balances** equals the claimed `totalLiabilities`

The Soroban contract then verifies this using the Groth16 pairing equation:

```
e(-A, B) * e(alpha, beta) * e(vk_x, gamma) * e(C, delta) == 1
```

Where `vk_x = IC[0] + totalLiabilities * IC[1]` is computed using BN254 host functions native to Stellar.

If the proof checks out AND `reserveBalance >= totalLiabilities`, the contract stamps **SOLVENT** on the ledger.

---

## Known Limitations

- Currently supports exactly 5 accounts (circuit hardcoded to N=5)
- The verification key is passed as a parameter — in production it should be hardcoded at deploy time
- Not audited — do not use with real assets
- Demo uses mock data

---

## Hackathon

**Event**: Real-World ZK on Stellar  
**Deadline**: June 29, 2026  
**Prize pool**: $10,000 in XLM
