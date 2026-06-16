// Converts verification_key.json into Rust byte-array constants for the Soroban contract.
// Run: node scripts/vk_to_rust.js

const fs = require("fs");
const path = require("path");

const vk = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../keys/verification_key.json"))
);

// Convert a decimal string to a 32-byte big-endian hex array
function decToBytes32(dec) {
  let hex = BigInt(dec).toString(16).padStart(64, "0");
  const bytes = [];
  for (let i = 0; i < 64; i += 2) bytes.push("0x" + hex.slice(i, i + 2));
  return bytes;
}

// G1 point (affine): x (32 bytes) + y (32 bytes) = 64 bytes total
function g1ToBytes(point) {
  return [...decToBytes32(point[0]), ...decToBytes32(point[1])];
}

// G2 point (affine, Fp2 elements): x.im + x.re + y.im + y.re = 128 bytes
function g2ToBytes(point) {
  return [
    ...decToBytes32(point[0][0]),
    ...decToBytes32(point[0][1]),
    ...decToBytes32(point[1][0]),
    ...decToBytes32(point[1][1]),
  ];
}

function rustArray(name, bytes) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    lines.push("    " + bytes.slice(i, i + 16).join(", "));
  }
  return `pub const ${name}: [u8; ${bytes.length}] = [\n${lines.join(",\n")},\n];`;
}

const alpha = g1ToBytes(vk.vk_alpha_1);
const beta  = g2ToBytes(vk.vk_beta_2);
const gamma = g2ToBytes(vk.vk_gamma_2);
const delta = g2ToBytes(vk.vk_delta_2);
const ic0   = g1ToBytes(vk.IC[0]);
const ic1   = g1ToBytes(vk.IC[1]);

const rust = `// Auto-generated from verification_key.json — do not edit manually.
// Run: node scripts/vk_to_rust.js

${rustArray("VK_ALPHA_G1", alpha)}

${rustArray("VK_BETA_G2", beta)}

${rustArray("VK_GAMMA_G2", gamma)}

${rustArray("VK_DELTA_G2", delta)}

${rustArray("VK_IC0", ic0)}

${rustArray("VK_IC1", ic1)}
`;

const outPath = path.join(
  __dirname,
  "../contract/contracts/proof-of-reserves/src/vk.rs"
);
fs.writeFileSync(outPath, rust);
console.log("Written:", outPath);
