/** Marker of values written by the vault; the format lives apart so checking it needs no crypto code. */
export const ENCRYPTED_PREFIX = "enc:v1:";

export const isEncrypted = (value: string): boolean => value.startsWith(ENCRYPTED_PREFIX);
