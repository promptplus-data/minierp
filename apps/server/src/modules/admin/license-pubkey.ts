/**
 * Ed25519 public key that verifies license keys (REQ-M19-11), embedded in the on-prem build (SPKI DER, base64).
 *
 * Only this public half is in the repository. The private key is held by SCG outside the repository and is
 * given to the cloud server as LICENSE_SIGNING_KEY (secret store) or to scripts/license-gen.mjs via --key-file.
 * Rotate: `node scripts/license-gen.mjs --keygen --out <file outside the repo>`, paste the printed public key here.
 *
 * Tests and e2e sign with a throw-away keypair and point the verifier at it with ERP_LICENSE_TEST_PUBKEY
 * (ignored when NODE_ENV is production).
 */
export const LICENSE_PUBLIC_KEY_SPKI_B64 = 'MCowBQYDK2VwAyEAeAbydx2MN7amOjvreKgWs38acaSajs00l82mJ4oDVm0=';
