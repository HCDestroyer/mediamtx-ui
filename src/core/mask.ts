export const MASK = "••••••••";

/** Hides credentials in a URL: `user:pass@`, `passphrase=…` and the `#streamKey` fragment. */
export function maskUrlSecrets(value: string): string {
  return value
    .replace(/(:\/\/[^/:@\s]+:)[^@/\s]+@/, `$1${MASK}@`)
    .replace(/([?&]passphrase=)[^&#\s]*/, `$1${MASK}`)
    .replace(/#.+$/, `#${MASK}`);
}
