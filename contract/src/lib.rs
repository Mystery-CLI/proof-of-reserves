#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    vec, Bytes, BytesN, Env, Vec,
};

// ----------------------------------------------------------------
// Proof-of-Reserves Verifier Contract
//
// What this contract does:
//   1. Accepts a Groth16 ZK proof from the issuer
//   2. Verifies the proof using BN254 elliptic curve operations
//      (native host functions added in Stellar Protocol 25/26)
//   3. Checks that the issuer's reserve balance >= total liabilities
//   4. Records a timestamped SOLVENT / INSOLVENT status on-chain
//
// The proof proves (without revealing individual balances):
//   - All account balances are non-negative
//   - Their sum equals the public totalLiabilities value
// ----------------------------------------------------------------

// On-chain storage keys
const LAST_VERIFIED: soroban_sdk::Symbol = symbol_short!("LAST_VER");
const IS_SOLVENT: soroban_sdk::Symbol = symbol_short!("SOLVENT");
const TOTAL_LIAB: soroban_sdk::Symbol = symbol_short!("LIAB");
const RESERVE_BAL: soroban_sdk::Symbol = symbol_short!("RESERVE");

// A G1 point on BN254 (x, y coordinates as 32-byte big-endian values)
#[contracttype]
pub struct G1Point {
    pub x: BytesN<32>,
    pub y: BytesN<32>,
}

// A G2 point on BN254 (two coordinates, each with two 32-byte components)
#[contracttype]
pub struct G2Point {
    pub x0: BytesN<32>,
    pub x1: BytesN<32>,
    pub y0: BytesN<32>,
    pub y1: BytesN<32>,
}

// The Groth16 proof (three elliptic curve points)
#[contracttype]
pub struct Groth16Proof {
    pub a: G1Point,  // pi_a
    pub b: G2Point,  // pi_b
    pub c: G1Point,  // pi_c
}

// Verification key — embedded from the trusted setup (verification_key.json)
#[contracttype]
pub struct VerificationKey {
    pub alpha: G1Point,
    pub beta: G2Point,
    pub gamma: G2Point,
    pub delta: G2Point,
    pub ic: Vec<G1Point>, // input commitments: ic[0] + sum(inputs[i] * ic[i+1])
}

// The result stored on-chain after each verification
#[contracttype]
pub struct SolvencyRecord {
    pub is_solvent: bool,
    pub total_liabilities: i128,
    pub reserve_balance: i128,
    pub verified_at_ledger: u32,
}

#[contract]
pub struct ProofOfReservesContract;

#[contractimpl]
impl ProofOfReservesContract {

    /// Called by the issuer to prove solvency.
    ///
    /// Parameters:
    ///   proof           — the Groth16 ZK proof
    ///   vk              — the verification key from the trusted setup
    ///   total_liabilities — public output from the ZK circuit (sum of all balances)
    ///   reserve_balance   — the issuer's actual reserve amount (verifiable off-chain via Stellar ledger)
    ///
    /// Returns true if the proof is valid AND reserves >= liabilities.
    pub fn verify_solvency(
        env: Env,
        proof: Groth16Proof,
        vk: VerificationKey,
        total_liabilities: i128,
        reserve_balance: i128,
    ) -> bool {

        // Step 1: Verify the ZK proof using BN254 pairing check
        let proof_valid = Self::verify_groth16(&env, &proof, &vk, total_liabilities);

        // Step 2: Check that reserves cover all liabilities
        let is_solvent = proof_valid && reserve_balance >= total_liabilities;

        // Step 3: Store the result on-chain (permanent public record)
        let record = SolvencyRecord {
            is_solvent,
            total_liabilities,
            reserve_balance,
            verified_at_ledger: env.ledger().sequence(),
        };
        env.storage().instance().set(&LAST_VERIFIED, &record);
        env.storage().instance().set(&IS_SOLVENT, &is_solvent);
        env.storage().instance().set(&TOTAL_LIAB, &total_liabilities);
        env.storage().instance().set(&RESERVE_BAL, &reserve_balance);

        is_solvent
    }

    /// Returns the most recent solvency record stored on-chain.
    pub fn get_solvency_status(env: Env) -> SolvencyRecord {
        env.storage()
            .instance()
            .get(&LAST_VERIFIED)
            .unwrap_or(SolvencyRecord {
                is_solvent: false,
                total_liabilities: 0,
                reserve_balance: 0,
                verified_at_ledger: 0,
            })
    }

    /// Core Groth16 verifier using BN254 host functions.
    ///
    /// Groth16 verification equation:
    ///   e(A, B) == e(alpha, beta) * e(vk_x, gamma) * e(C, delta)
    ///
    /// Rearranged for a single multi-pairing check (equals identity):
    ///   e(-A, B) * e(alpha, beta) * e(vk_x, gamma) * e(C, delta) == 1
    fn verify_groth16(
        env: &Env,
        proof: &Groth16Proof,
        vk: &VerificationKey,
        total_liabilities: i128,
    ) -> bool {

        // Compute vk_x = IC[0] + total_liabilities * IC[1]
        // This is the linear combination of public inputs with input commitments
        let vk_x = Self::compute_vk_x(env, vk, total_liabilities);

        // Build the four pairing inputs for the batch pairing check
        // e(-A, B) * e(alpha, beta) * e(vk_x, gamma) * e(C, delta) == 1
        let neg_a = Self::negate_g1(env, &proof.a);

        // Encode all points for the BN254 pairing host function
        let mut pairing_input = Bytes::new(env);

        // Pair 1: (-A, B)
        pairing_input.append(&Self::encode_g1(env, &neg_a));
        pairing_input.append(&Self::encode_g2(env, &proof.b));

        // Pair 2: (alpha, beta)
        pairing_input.append(&Self::encode_g1(env, &vk.alpha));
        pairing_input.append(&Self::encode_g2(env, &vk.beta));

        // Pair 3: (vk_x, gamma)
        pairing_input.append(&Self::encode_g1(env, &vk_x));
        pairing_input.append(&Self::encode_g2(env, &vk.gamma));

        // Pair 4: (C, delta)
        pairing_input.append(&Self::encode_g1(env, &proof.c));
        pairing_input.append(&Self::encode_g2(env, &vk.delta));

        // Call the BN254 pairing host function — returns true if product == 1
        env.crypto().bn254_pairing_check(pairing_input)
    }

    /// Computes the linear combination: vk_x = IC[0] + total_liabilities * IC[1]
    fn compute_vk_x(env: &Env, vk: &VerificationKey, total_liabilities: i128) -> G1Point {
        // IC[0] is the base point
        let ic0 = vk.ic.get(0).unwrap();

        // IC[1] scaled by the public input (total_liabilities)
        let scalar = Self::i128_to_scalar(env, total_liabilities);
        let ic1 = vk.ic.get(1).unwrap();

        // ic1_scaled = total_liabilities * IC[1]
        let ic1_input = Self::encode_g1(env, &ic1);
        let ic1_scaled_bytes = env.crypto().bn254_g1_mul(ic1_input, scalar);
        let ic1_scaled = Self::decode_g1(env, ic1_scaled_bytes);

        // vk_x = IC[0] + ic1_scaled
        let a_bytes = Self::encode_g1(env, &ic0);
        let b_bytes = Self::encode_g1(env, &ic1_scaled);
        let sum_bytes = env.crypto().bn254_g1_add(a_bytes, b_bytes);
        Self::decode_g1(env, sum_bytes)
    }

    /// Negates a G1 point (x, -y mod p) for the pairing equation
    fn negate_g1(env: &Env, point: &G1Point) -> G1Point {
        // BN254 field prime p = 21888242871839275222246405745257275088696311157297823662689037894645226208583
        let p_bytes: [u8; 32] = [
            0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
            0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
            0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d,
            0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
        ];

        // Compute -y = p - y (mod p)
        let y_val = Self::bytes32_to_u256(&point.y);
        let neg_y_val = if y_val == [0u8; 32] {
            [0u8; 32]
        } else {
            Self::u256_sub(&p_bytes, &y_val)
        };
        let neg_y = BytesN::<32>::from_array(env, &neg_y_val);

        G1Point { x: point.x.clone(), y: neg_y }
    }

    // ---- Encoding helpers ----

    fn encode_g1(env: &Env, p: &G1Point) -> Bytes {
        let mut b = Bytes::new(env);
        b.append(&Bytes::from(p.x.clone()));
        b.append(&Bytes::from(p.y.clone()));
        b
    }

    fn encode_g2(env: &Env, p: &G2Point) -> Bytes {
        let mut b = Bytes::new(env);
        b.append(&Bytes::from(p.x0.clone()));
        b.append(&Bytes::from(p.x1.clone()));
        b.append(&Bytes::from(p.y0.clone()));
        b.append(&Bytes::from(p.y1.clone()));
        b
    }

    fn decode_g1(env: &Env, bytes: Bytes) -> G1Point {
        let x: BytesN<32> = bytes.slice(0..32).try_into().unwrap();
        let y: BytesN<32> = bytes.slice(32..64).try_into().unwrap();
        G1Point { x, y }
    }

    fn i128_to_scalar(env: &Env, val: i128) -> BytesN<32> {
        let mut arr = [0u8; 32];
        let val_bytes = val.to_be_bytes();
        arr[16..32].copy_from_slice(&val_bytes);
        BytesN::<32>::from_array(env, &arr)
    }

    fn bytes32_to_u256(b: &BytesN<32>) -> [u8; 32] {
        let mut arr = [0u8; 32];
        for i in 0..32 {
            arr[i] = b.get(i as u32).unwrap();
        }
        arr
    }

    fn u256_sub(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
        let mut result = [0u8; 32];
        let mut borrow: i16 = 0;
        for i in (0..32).rev() {
            let diff = (a[i] as i16) - (b[i] as i16) - borrow;
            result[i] = diff.rem_euclid(256) as u8;
            borrow = if diff < 0 { 1 } else { 0 };
        }
        result
    }
}
