# Codespaces Handoff — Proof-of-Reserves on Stellar

## What This Project Is
A zero-knowledge Proof-of-Reserves system on Stellar. A stablecoin issuer proves their reserve balance covers all user liabilities WITHOUT revealing individual account balances. Built for the "Real-World ZK on Stellar" hackathon (deadline June 29, 2026).

**ZK stack**: Circom 2 circuit → Groth16 proof (snarkjs) → Soroban verifier contract on Stellar testnet.

---

## What Is Already Done (do not redo these)

### 1. ZK Circuit — COMPLETE
- File: `circuits/reserves.circom`
- Proves: 5 private balances are non-negative AND their sum equals a public `totalLiabilities`
- Compiled to: `keys/reserves_js/reserves.wasm` and `keys/reserves.r1cs`

### 2. Trusted Setup — COMPLETE
- `keys/pot12_final.ptau` — Powers of Tau ceremony
- `keys/reserves_final.zkey` — Circuit proving key
- `keys/verification_key.json` — Verification key (used by the Soroban contract)

### 3. Proof Generator — COMPLETE
- File: `scripts/generate_proof.js`
- Run with: `node scripts/generate_proof.js`
- Takes 5 hardcoded private balances, generates a Groth16 proof, verifies locally
- Output: `keys/proof.json` and `keys/calldata.txt`
- **Already tested and working** — produces valid proofs

### 4. Soroban Contract — WRITTEN, NOT YET COMPILED
- File: `contract/src/lib.rs`
- The main contract with full Groth16 verification logic using Stellar BN254 host functions
- `contract/Cargo.toml` has `soroban-sdk = "22.0.0"`
- File: `contract/contracts/proof-of-reserves/src/vk.rs` — auto-generated Rust byte arrays from the verification key
- **Problem on Windows**: Could not compile because `link.exe` (MSVC) was missing. Linux/Codespaces will not have this problem.

### 5. VK Converter Script — COMPLETE
- File: `scripts/vk_to_rust.js`
- Converts `keys/verification_key.json` into Rust byte-array constants
- Already run — output is in `contract/contracts/proof-of-reserves/src/vk.rs`

---

## What You Need To Do In Codespaces

### Step 1: Install tools
```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source $HOME/.cargo/env

# Add wasm target
rustup target add wasm32-unknown-unknown

# Install Stellar CLI
cargo install --locked stellar-cli --features opt

# Install Node deps (for proof generation)
npm install
```

### Step 2: Fix the soroban-sdk version
The `contract/Cargo.toml` has `soroban-sdk = "22.0.0"` but this may not have BN254 support (added in Protocol 25). Check the latest compatible version:
```bash
cargo search soroban-sdk
```
Update `contract/Cargo.toml` to use the latest version that supports BN254 (`env.crypto().bn254_g1_add`, `bn254_g1_mul`, `bn254_pairing_check`).

### Step 3: Try to build the contract
```bash
cd contract
stellar contract build
```

If there are API errors for BN254 functions, the function names may differ slightly in the installed SDK version. Common alternatives:
- `bn254_g1_mul` might be `bn254_g1_scalar_mul`
- `bn254_pairing_check` might take a `Vec<(Bytes, Bytes)>` instead of flat `Bytes`

Fix any compilation errors in `contract/src/lib.rs`.

### Step 4: Set up Stellar testnet identity
```bash
stellar keys generate --global deployer --network testnet
stellar keys address deployer
# Fund it:
stellar network use testnet
curl "https://friendbot.stellar.org?addr=$(stellar keys address deployer)"
```

### Step 5: Deploy the contract
```bash
cd contract
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/proof_of_reserves.wasm \
  --source deployer \
  --network testnet
```
Save the contract ID that gets printed.

### Step 6: Test the contract end-to-end
```bash
# First generate a proof
node scripts/generate_proof.js

# Then call the contract (use the proof values from keys/proof.json)
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source deployer \
  --network testnet \
  -- verify_solvency \
  --proof ... \
  --vk ... \
  --total_liabilities 1000000 \
  --reserve_balance 1200000
```

### Step 7: Build the frontend
Create `frontend/index.html` — a simple demo page that:
- Shows the 5 private account balances (in a "locked" state)
- Has a "Generate Proof & Verify On-Chain" button
- Calls the Stellar contract and shows "SOLVENT ✓" or "INSOLVENT ✗"
- Shows the Stellar testnet transaction link as proof

---

## Key Files Reference
```
proof-of-reserves/
├── circuits/reserves.circom          # ZK circuit (done)
├── keys/
│   ├── reserves.r1cs                 # Compiled circuit (done)
│   ├── reserves_js/reserves.wasm     # Witness generator (done)
│   ├── reserves_final.zkey           # Proving key (done)
│   └── verification_key.json         # Verification key (done)
├── scripts/
│   ├── generate_proof.js             # Proof generator (done, tested)
│   └── vk_to_rust.js                 # VK → Rust converter (done)
├── contract/
│   ├── Cargo.toml                    # soroban-sdk version may need updating
│   └── src/lib.rs                    # Soroban verifier contract (written, needs compile)
│       contracts/proof-of-reserves/
│           src/vk.rs                 # Auto-generated VK byte arrays
└── frontend/                         # Empty — needs to be built
```

## Contract Overview (what lib.rs does)
1. `verify_solvency(proof, vk, total_liabilities, reserve_balance)` — main function
2. Computes `vk_x = IC[0] + total_liabilities * IC[1]` using BN254 scalar mul + add
3. Negates proof.A (flips y coordinate mod BN254 field prime)
4. Calls `bn254_pairing_check` with 4 pairs: `(-A,B), (alpha,beta), (vk_x,gamma), (C,delta)`
5. Checks `reserve_balance >= total_liabilities`
6. Stores `SolvencyRecord` on-chain with ledger sequence number
7. `get_solvency_status()` — read the last recorded result

## Important Notes
- Amounts are in cents (e.g. 1000000 = $10,000.00)
- The VK is passed as a parameter (not hardcoded) — note this as a known limitation in the README
- BN254 field prime: `0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47`
- The circuit supports exactly 5 accounts (N=5 hardcoded in circom)
- Testnet only — do not use with real assets
