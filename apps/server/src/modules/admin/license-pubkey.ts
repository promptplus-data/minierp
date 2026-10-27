/**
 * Ed25519 public key that verifies license keys (REQ-M19-11), embedded in the on-prem build (SPKI DER, base64).
 *
 * This is the DEVELOPMENT key; its private half is apps/server/test/admin/fixtures/license-dev-private.pem and is
 * used by tests and e2e only. Before a production release, replace this value with the production public key
 * (apps/server/src/modules/admin/README.md "Production license keypair"). The production private key lives only in
 * the cloud server's secret store (LICENSE_SIGNING_KEY) and never in this repository.
 */
export const LICENSE_PUBLIC_KEY_SPKI_B64 = 'MCowBQYDK2VwAyEAhZYKjVsTSeNGG2dTduXm0BVRK9er44IT+8X5nDAIdGg=';
export const DEV_LICENSE_PUBLIC_KEY_SPKI_B64 = 'MCowBQYDK2VwAyEAhZYKjVsTSeNGG2dTduXm0BVRK9er44IT+8X5nDAIdGg=';
