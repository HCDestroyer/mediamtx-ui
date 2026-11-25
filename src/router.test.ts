import { describe, expect, it } from "vitest";
import { hrefFor, parseHash } from "./router";

describe("parseHash", () => {
  it("maps the known routes", () => {
    expect(parseHash("")).toEqual({ name: "channels" });
    expect(parseHash("#/")).toEqual({ name: "channels" });
    expect(parseHash("#/connections")).toEqual({ name: "connections" });
    expect(parseHash("#/servers")).toEqual({ name: "servers" });
    expect(parseHash("#/settings")).toEqual({ name: "settings" });
  });

  it("decodes channel names", () => {
    expect(parseHash("#/channels/canal%2063")).toEqual({ name: "channel", channel: "canal 63" });
    expect(hrefFor({ name: "channel", channel: "canal 63" })).toBe("#/channels/canal%2063");
  });

  it("falls back to not-found", () => {
    expect(parseHash("#/nope")).toEqual({ name: "not-found" });
    expect(parseHash("#/servers/extra")).toEqual({ name: "not-found" });
  });
});
