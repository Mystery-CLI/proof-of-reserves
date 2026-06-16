pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/bitify.circom";
include "../node_modules/circomlib/circuits/comparators.circom";

/*
 * ProofOfReserves(N)
 *
 * Proves that:
 *   1. Each balance is a valid non-negative number (fits in 64 bits)
 *   2. The sum of all private balances equals the public totalLiabilities
 *
 * The on-chain contract then checks: reserveBalance >= totalLiabilities
 * Since reserve accounts are public on Stellar, no ZK needed for that part.
 *
 * Private inputs: balances[N]  — individual account balances (never revealed)
 * Public inputs:  totalLiabilities — the sum the issuer claims they owe
 */
template ProofOfReserves(N) {
    // Private: individual account balances (hidden from everyone)
    signal input balances[N];

    // Public: total amount owed to all users (visible on-chain)
    signal output totalLiabilities;

    // Step 1: Range-check each balance — prove it fits in 64 bits (non-negative, < 2^64)
    component rangeCheck[N];
    for (var i = 0; i < N; i++) {
        rangeCheck[i] = Num2Bits(64);
        rangeCheck[i].in <== balances[i];
    }

    // Step 2: Sum all balances
    signal runningSum[N + 1];
    runningSum[0] <== 0;
    for (var i = 0; i < N; i++) {
        runningSum[i + 1] <== runningSum[i] + balances[i];
    }

    // Step 3: The final sum must equal the claimed totalLiabilities
    totalLiabilities <== runningSum[N];
}

// We prove for 5 accounts (expandable — change N for production)
component main = ProofOfReserves(5);
