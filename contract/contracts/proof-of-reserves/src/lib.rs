#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, vec,
    BytesN, Env,
    crypto::bn254::{Bn254Fr, Bn254G1Affine, Bn254G2Affine},
};

const LAST_VERIFIED: soroban_sdk::Symbol = symbol_short!("LAST_VER");
const IS_SOLVENT: soroban_sdk::Symbol = symbol_short!("SOLVENT");
const TOTAL_LIAB: soroban_sdk::Symbol = symbol_short!("LIAB");
const RESERVE_BAL: soroban_sdk::Symbol = symbol_short!("RESERVE");

// A Groth16 proof: pi_a (G1), pi_b (G2), pi_c (G1).
// G1 = 64 bytes (x||y), G2 = 128 bytes (X.c1||X.c0||Y.c1||Y.c0) — Ethereum-compatible.
#[contracttype]
pub struct Groth16Proof {
    pub a: BytesN<64>,
    pub b: BytesN<128>,
    pub c: BytesN<64>,
}

// Verification key from the Groth16 trusted setup.
// IC has exactly 2 entries for this circuit (1 public input = totalLiabilities).
#[contracttype]
pub struct VerificationKey {
    pub alpha: BytesN<64>,
    pub beta: BytesN<128>,
    pub gamma: BytesN<128>,
    pub delta: BytesN<128>,
    pub ic0: BytesN<64>,
    pub ic1: BytesN<64>,
}

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

    /// Verify a Groth16 proof and record solvency status on-chain.
    /// Returns true if the proof is valid AND reserve_balance >= total_liabilities.
    pub fn verify_solvency(
        env: Env,
        proof: Groth16Proof,
        vk: VerificationKey,
        total_liabilities: i128,
        reserve_balance: i128,
    ) -> bool {
        let proof_valid = Self::verify_groth16(&env, &proof, &vk, total_liabilities);
        let is_solvent = proof_valid && reserve_balance >= total_liabilities;

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

    // Groth16 verification equation:
    //   e(-A, B) * e(alpha, beta) * e(vk_x, gamma) * e(C, delta) == 1
    // where vk_x = IC[0] + total_liabilities * IC[1]
    fn verify_groth16(
        env: &Env,
        proof: &Groth16Proof,
        vk: &VerificationKey,
        total_liabilities: i128,
    ) -> bool {
        let bn254 = env.crypto().bn254();

        // Compute vk_x = IC[0] + total_liabilities * IC[1]
        let ic0 = Bn254G1Affine::from_bytes(vk.ic0.clone());
        let ic1 = Bn254G1Affine::from_bytes(vk.ic1.clone());
        let scalar = Self::i128_to_fr(env, total_liabilities);
        let ic1_scaled = bn254.g1_mul(&ic1, &scalar);
        let vk_x = bn254.g1_add(&ic0, &ic1_scaled);

        // Negate A (the SDK implements Neg for Bn254G1Affine)
        let neg_a = -Bn254G1Affine::from_bytes(proof.a.clone());

        // Pairing check: e(-A,B) * e(alpha,beta) * e(vk_x,gamma) * e(C,delta) == 1
        let g1s = vec![
            env,
            neg_a,
            Bn254G1Affine::from_bytes(vk.alpha.clone()),
            vk_x,
            Bn254G1Affine::from_bytes(proof.c.clone()),
        ];
        let g2s = vec![
            env,
            Bn254G2Affine::from_bytes(proof.b.clone()),
            Bn254G2Affine::from_bytes(vk.beta.clone()),
            Bn254G2Affine::from_bytes(vk.gamma.clone()),
            Bn254G2Affine::from_bytes(vk.delta.clone()),
        ];

        bn254.pairing_check(g1s, g2s)
    }

    fn i128_to_fr(env: &Env, val: i128) -> Bn254Fr {
        let mut arr = [0u8; 32];
        arr[16..32].copy_from_slice(&val.to_be_bytes());
        Bn254Fr::from_bytes(BytesN::<32>::from_array(env, &arr))
    }
}

mod test;
