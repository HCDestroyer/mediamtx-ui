import { describe, expect, it } from "vitest";
import { generatePassphrase } from "./passphrase";
import { PASSPHRASE_MAX, PASSPHRASE_MIN, validatePassphrase } from "./mediamtx/pathConf";

describe("generatePassphrase", () => {
  it("has the requested length and is valid for SRT", () => {
    for (const length of [PASSPHRASE_MIN, 24, PASSPHRASE_MAX]) {
      const value = generatePassphrase(length);
      expect(value).toHaveLength(length);
      expect(validatePassphrase(value)).toBeNull();
    }
  });

  it("avoids look-alike characters and differs between calls", () => {
    const a = generatePassphrase(200);
    expect(a).not.toMatch(/[0O1lI]/);
    expect(a).not.toBe(generatePassphrase(200));
  });

  it("rejects biased bytes instead of wrapping them", () => {
    // 54 symbols: bytes 216..255 would favor the first characters, so they are skipped.
    const biased = (n: number) => new Uint8Array(n).fill(255);
    let calls = 0;
    const source = (n: number) => (calls++ === 0 ? biased(n) : new Uint8Array(n).fill(0));
    expect(generatePassphrase(5, source)).toBe("AAAAA");
  });
});
