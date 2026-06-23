#![cfg(test)]

use super::*;
use soroban_sdk::Env;

#[test]
fn test_get_solvency_status_default() {
    let env = Env::default();
    let contract_id = env.register(ProofOfReservesContract, ());
    let client = ProofOfReservesContractClient::new(&env, &contract_id);

    let status = client.get_solvency_status();
    assert_eq!(status.is_solvent, false);
    assert_eq!(status.total_liabilities, 0);
    assert_eq!(status.reserve_balance, 0);
    assert_eq!(status.verified_at_ledger, 0);
}
