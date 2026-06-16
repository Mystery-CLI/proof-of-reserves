const snarkjs = require("snarkjs");
const fs = require("fs");
const path = require("path");

/*
 * generate_proof.js
 *
 * Takes a list of private account balances, generates a ZK proof that:
 *   - Each balance is non-negative
 *   - Their sum equals the public totalLiabilities
 *
 * Usage:
 *   node scripts/generate_proof.js
 *
 * The "balances" below are PRIVATE — they never appear in the proof.
 * Only "totalLiabilities" is made public (on-chain).
 */

async function main() {
    // ---------------------------------------------------------------
    // PRIVATE INPUT: individual account balances (in cents, e.g. USD)
    // In production these come from your internal database.
    // ---------------------------------------------------------------
    const balances = [
        300000,   // Alice:   $3,000.00
        150000,   // Bob:     $1,500.00
        200000,   // Carol:   $2,000.00
        80000,    // David:   $800.00
        270000,   // Eve:     $2,700.00
    ];

    // Compute total (this is what goes public on-chain)
    const totalLiabilities = balances.reduce((a, b) => a + b, 0);

    console.log("=== Proof of Reserves ===");
    console.log("Private balances (NEVER revealed):", balances);
    console.log("Public total liabilities: $" + (totalLiabilities / 100).toFixed(2));
    console.log("");

    // Circuit input — balances stay private, total becomes the public output
    const input = { balances };

    const wasmPath = path.join(__dirname, "../keys/reserves_js/reserves.wasm");
    const zkeyPath = path.join(__dirname, "../keys/reserves_final.zkey");

    console.log("Generating proof (this takes a few seconds)...");
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);

    console.log("Proof generated!");
    console.log("Public signals (on-chain visible):", publicSignals);
    console.log("  → Total liabilities confirmed: $" + (parseInt(publicSignals[0]) / 100).toFixed(2));
    console.log("");

    // Verify the proof locally before submitting on-chain
    const vkeyPath = path.join(__dirname, "../keys/verification_key.json");
    const vKey = JSON.parse(fs.readFileSync(vkeyPath));
    const isValid = await snarkjs.groth16.verify(vKey, publicSignals, proof);

    console.log("Local verification:", isValid ? "PASSED ✓" : "FAILED ✗");
    console.log("");

    // Save proof + public signals to disk (for the Soroban contract submission)
    const output = { proof, publicSignals };
    fs.writeFileSync(path.join(__dirname, "../keys/proof.json"), JSON.stringify(output, null, 2));
    console.log("Proof saved to keys/proof.json");

    // Also export the Solidity/contract-ready calldata format
    const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
    fs.writeFileSync(path.join(__dirname, "../keys/calldata.txt"), calldata);
    console.log("Contract calldata saved to keys/calldata.txt");
}

main().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
});
