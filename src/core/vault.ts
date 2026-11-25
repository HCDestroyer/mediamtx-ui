import { gcm } from "@noble/ciphers/aes.js";
import { argon2idAsync } from "@noble/hashes/argon2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { ENCRYPTED_PREFIX, isEncrypted } from "./vaultFormat";

export { isEncrypted };

/**
 * Local vault: a key derived from the panel password encrypts what must not sit
 * in clear text in the browser (server credentials). Pure JavaScript crypto is
 * used on purpose: WebCrypto (`crypto.subtle`) does not exist on plain http
 * pages, and the panel is typically served over http inside a LAN.
 */

export interface KdfParams {
  /** Memory in KiB. */
  m: number;
  /** Iterations. */
  t: number;
  /** Parallelism. */
  p: number;
}

/** argon2id, OWASP minimum profile. */
export const DEFAULT_KDF: KdfParams = { m: 19456, t: 2, p: 1 };

export interface VaultMeta {
  version: 1;
  username: string;
  kdf: "argon2id";
  params: KdfParams;
  salt: string;
  /** A known string encrypted with the key; decrypting it proves the password. */
  verifier: string;
}

const VERIFIER_PLAINTEXT = "nodo-vault-v1";
const VERIFIER_AAD = "nodo:verifier";
const PREFIX = ENCRYPTED_PREFIX;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function deriveKey(password: string, salt: Uint8Array, params: KdfParams): Promise<Uint8Array> {
  return argon2idAsync(encoder.encode(password), salt, { ...params, dkLen: 32, asyncTick: 10 });
}

function seal(key: Uint8Array, plaintext: string, aad: string): string {
  const nonce = randomBytes(12);
  const cipher = gcm(key, nonce, encoder.encode(aad)).encrypt(encoder.encode(plaintext));
  const out = new Uint8Array(nonce.length + cipher.length);
  out.set(nonce);
  out.set(cipher, nonce.length);
  return toBase64(out);
}

function open(key: Uint8Array, sealed: string, aad: string): string {
  const bytes = fromBase64(sealed);
  const plain = gcm(key, bytes.slice(0, 12), encoder.encode(aad)).decrypt(bytes.slice(12));
  return decoder.decode(plain);
}

export interface CreatedVault {
  meta: VaultMeta;
  key: Uint8Array;
}

export async function createVault(
  username: string,
  password: string,
  params: KdfParams = DEFAULT_KDF,
): Promise<CreatedVault> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, params);
  return {
    key,
    meta: {
      version: 1, username: username.trim(), kdf: "argon2id", params, salt: toBase64(salt),
      verifier: seal(key, VERIFIER_PLAINTEXT, VERIFIER_AAD),
    },
  };
}

/** Returns the key when username and password are right, otherwise null. */
export async function unlockVault(meta: VaultMeta, username: string, password: string): Promise<Uint8Array | null> {
  // The key is derived even for a wrong username so both failures take the same time.
  const key = await deriveKey(password, fromBase64(meta.salt), meta.params);
  if (username.trim() !== meta.username) return null;
  try {
    return open(key, meta.verifier, VERIFIER_AAD) === VERIFIER_PLAINTEXT ? key : null;
  } catch {
    return null;
  }
}

/** Encrypts a stored value; `name` is bound to the ciphertext so values cannot be swapped between keys. */
export const encryptValue = (key: Uint8Array, name: string, plaintext: string): string =>
  PREFIX + seal(key, plaintext, `nodo:value:${name}`);

/** Throws when the key is wrong or the data was altered. */
export const decryptValue = (key: Uint8Array, name: string, value: string): string =>
  open(key, value.slice(PREFIX.length), `nodo:value:${name}`);
