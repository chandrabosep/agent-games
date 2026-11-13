#!/usr/bin/env bash
# Compile the Policy Vault circuit and run the Groth16 setup.
#
# Phase 1 is the public Hermez Powers of Tau ceremony (power 13, checked against the blake2b hash
# that the snarkjs README publishes). Phase 2 is one contribution made by whoever runs this
# script, from fresh randomness. Whoever holds that randomness could forge proofs for this
# circuit, so rerunning the setup produces a new verification key (and a new vkHash on zkVerify).
#
# Usage: PTAU=/path/to/powersOfTau28_hez_final_13.ptau wildcard/scripts/build-circuit.sh
# Needs circom 2.2.x on PATH and `npm install` run in wildcard/.
set -euo pipefail
cd "$(dirname "$0")/.."

PTAU="${PTAU:?set PTAU to powersOfTau28_hez_final_13.ptau (https://circom.info/powersOfTau28_hez_final_13.ptau)}"
PTAU_B2="58efc8bf2834d04768a3d7ffcd8e1e23d461561729beaac4e3e7a47829a1c9066d5320241e124a1a8e8aa6c75be0ba66f65bc8239a0542ed38e11276f6fdb4d9"
got=$(python3 -c "import hashlib,sys;print(hashlib.blake2b(open(sys.argv[1],'rb').read()).hexdigest())" "$PTAU")
[ "$got" = "$PTAU_B2" ] || { echo "ptau hash mismatch: $got" >&2; exit 1; }

SNARKJS="npx --no-install snarkjs"
mkdir -p build artifacts

circom circuits/policy_payment.circom --r1cs --wasm --sym -o build
$SNARKJS r1cs info build/policy_payment.r1cs

$SNARKJS groth16 setup build/policy_payment.r1cs "$PTAU" build/policy_payment_0000.zkey
$SNARKJS zkey contribute build/policy_payment_0000.zkey artifacts/policy_payment_final.zkey \
  --name="policy-vault phase 2" -e="$(head -c 64 /dev/urandom | base64)"
rm -f build/policy_payment_0000.zkey
$SNARKJS zkey verify build/policy_payment.r1cs "$PTAU" artifacts/policy_payment_final.zkey
$SNARKJS zkey export verificationkey artifacts/policy_payment_final.zkey artifacts/policy_payment_vk.json
cp build/policy_payment_js/policy_payment.wasm artifacts/policy_payment.wasm

(cd artifacts && shasum -a 256 policy_payment.wasm policy_payment_final.zkey policy_payment_vk.json > SHA256SUMS)
echo "done: wildcard/artifacts/"
