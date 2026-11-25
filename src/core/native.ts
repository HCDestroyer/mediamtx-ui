import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { setNativePlatform, setTransport } from "./http";
import { createBiometric, type Biometric, type BiometricBackend } from "./biometric";
import { createNativeTransport } from "./nativeTransport";

/** True inside the Android app, false in a browser. */
export const isNative = (): boolean => Capacitor.isNativePlatform();

/** Switches the app to the native HTTP stack. Call once at start-up, before any request. */
export function setupNative(): void {
  if (!isNative()) return;
  setNativePlatform(true);
  setTransport(createNativeTransport(CapacitorHttp));
}

const KEY = "nodo.biometric";

// The plugins are loaded on demand: a browser never needs them.
const nativeBackend: BiometricBackend = {
  async available() {
    const { BiometricAuth } = await import("@aparajita/capacitor-biometric-auth");
    return (await BiometricAuth.checkBiometry()).isAvailable;
  },
  async authenticate(reason) {
    const { BiometricAuth } = await import("@aparajita/capacitor-biometric-auth");
    try {
      await BiometricAuth.authenticate({ reason, cancelTitle: "Cancelar", allowDeviceCredential: false });
      return true;
    } catch {
      return false;
    }
  },
  async save(value) {
    const { SecureStoragePlugin } = await import("capacitor-secure-storage-plugin");
    await SecureStoragePlugin.set({ key: KEY, value });
  },
  async read() {
    const { SecureStoragePlugin } = await import("capacitor-secure-storage-plugin");
    try {
      return (await SecureStoragePlugin.get({ key: KEY })).value;
    } catch {
      return null; // the plugin throws when the key does not exist
    }
  },
  async remove() {
    const { SecureStoragePlugin } = await import("capacitor-secure-storage-plugin");
    await SecureStoragePlugin.remove({ key: KEY }).catch(() => undefined);
  },
};

const unsupported: BiometricBackend = {
  available: async () => false,
  authenticate: async () => false,
  save: async () => undefined,
  read: async () => null,
  remove: async () => undefined,
};

/** Biometric unlock backed by the phone; always unsupported in a browser. */
export const biometric: Biometric = createBiometric(isNative() ? nativeBackend : unsupported);

/** Hands text to the Android share sheet. Returns false when not running in the app. */
export async function shareText(title: string, text: string, dialogTitle: string): Promise<boolean> {
  if (!isNative()) return false;
  const { Share } = await import("@capacitor/share");
  await Share.share({ title, text, dialogTitle });
  return true;
}
