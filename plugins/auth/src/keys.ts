import { calculateJwkThumbprint, importJWK, type JWK } from "jose";

export const ID_TOKEN_ALG = "ES256";

type PrivateSigningKey = Exclude<Awaited<ReturnType<typeof importJWK>>, Uint8Array>;

export interface SigningKey {
  privateKey: PrivateSigningKey;
  publicJwk: JWK;
  kid: string;
}

export async function loadSigningKey(jwk: Record<string, unknown>): Promise<SigningKey> {
  const { d: _secret, kid: _ignored, ...publicMaterial } = jwk as JWK;
  const kid = await calculateJwkThumbprint(publicMaterial as JWK, "sha256");
  const imported = await importJWK({ ...(jwk as JWK), kid }, ID_TOKEN_ALG);
  if (imported instanceof Uint8Array) throw new Error("AUTH_SIGNING_JWK must be an asymmetric private key");
  return {
    privateKey: imported,
    publicJwk: { ...(publicMaterial as JWK), kid, use: "sig", alg: ID_TOKEN_ALG },
    kid,
  };
}
