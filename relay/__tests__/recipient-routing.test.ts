import {
  parseRecipientEthAddresses,
  parseRecipientPartyAliases,
  resolveRecipientEthAddress,
  resolveRecipientParty,
} from "../recipient-routing";
import { ethers } from "ethers";

describe("parseRecipientPartyAliases", () => {
  it("returns empty map for empty input", () => {
    expect(parseRecipientPartyAliases("", "CANTON_RECIPIENT_PARTY_ALIASES")).toEqual({});
  });

  it("parses valid JSON alias map", () => {
    const map = parseRecipientPartyAliases(
      JSON.stringify({
        "dde6467edc610708573d717a53c7c396::12200d9a833bb01839aa0c236eb5fe18008bd21fa980873a0c463ba1866506b4af9e":
          "minted-user-7de39963::122038887449dad08a7caecd8acf578db26b02b61773070bfa7013f7563d2c01adb9",
      }),
      "CANTON_RECIPIENT_PARTY_ALIASES"
    );

    expect(Object.keys(map)).toHaveLength(1);
  });

  it("throws on invalid JSON", () => {
    expect(() =>
      parseRecipientPartyAliases("{bad json", "CANTON_RECIPIENT_PARTY_ALIASES")
    ).toThrow("must be valid JSON object");
  });

  it("throws on non-object JSON", () => {
    expect(() =>
      parseRecipientPartyAliases("[]", "CANTON_RECIPIENT_PARTY_ALIASES")
    ).toThrow("must be a JSON object");
  });

  it("throws when alias value is empty", () => {
    expect(() =>
      parseRecipientPartyAliases(
        JSON.stringify({ "minted-user-1": "" }),
        "CANTON_RECIPIENT_PARTY_ALIASES"
      )
    ).toThrow("must be a non-empty string");
  });
});

describe("resolveRecipientParty", () => {
  const foreign =
    "dde6467edc610708573d717a53c7c396::12200d9a833bb01839aa0c236eb5fe18008bd21fa980873a0c463ba1866506b4af9e";
  const local =
    "minted-user-7de39963::122038887449dad08a7caecd8acf578db26b02b61773070bfa7013f7563d2c01adb9";

  it("returns direct alias when full party is mapped", () => {
    const out = resolveRecipientParty(foreign, { [foreign]: local });
    expect(out).toBe(local);
  });

  it("returns hint alias when only party hint is mapped", () => {
    const out = resolveRecipientParty(foreign, {
      dde6467edc610708573d717a53c7c396: local,
    });
    expect(out).toBe(local);
  });

  it("prefers direct alias over hint alias", () => {
    const directLocal =
      "minted-user-direct::122038887449dad08a7caecd8acf578db26b02b61773070bfa7013f7563d2c01adb9";
    const out = resolveRecipientParty(foreign, {
      [foreign]: directLocal,
      dde6467edc610708573d717a53c7c396: local,
    });
    expect(out).toBe(directLocal);
  });

  it("returns original recipient when no alias matches", () => {
    const out = resolveRecipientParty(foreign, {});
    expect(out).toBe(foreign);
  });
});

describe("parseRecipientEthAddresses", () => {
  it("returns empty map for empty input", () => {
    expect(parseRecipientEthAddresses("", "CANTON_REDEMPTION_ETH_RECIPIENTS")).toEqual({});
  });

  it("parses valid address map and normalizes checksum", () => {
    const map = parseRecipientEthAddresses(
      JSON.stringify({
        "minted-user-33f97321":
          "0x33f97321214b5b8443f6212a05836c8ffe42dda5",
      }),
      "CANTON_REDEMPTION_ETH_RECIPIENTS"
    );

    expect(map["minted-user-33f97321"]).toBe(
      ethers.getAddress("0x33f97321214b5b8443f6212a05836c8ffe42dda5")
    );
  });

  it("throws when address is invalid", () => {
    expect(() =>
      parseRecipientEthAddresses(
        JSON.stringify({ "minted-user-1": "not-an-address" }),
        "CANTON_REDEMPTION_ETH_RECIPIENTS"
      )
    ).toThrow("must be a valid Ethereum address");
  });
});

describe("resolveRecipientEthAddress", () => {
  const fullParty =
    "minted-user-33f97321::122038887449dad08a7caecd8acf578db26b02b61773070bfa7013f7563d2c01adb9";
  const mapped = "0x33f97321214b5B8443f6212a05836C8fFE42DdA5";

  it("returns direct mapping when full party is present", () => {
    expect(resolveRecipientEthAddress(fullParty, { [fullParty]: mapped })).toBe(mapped);
  });

  it("falls back to party hint mapping", () => {
    expect(resolveRecipientEthAddress(fullParty, { "minted-user-33f97321": mapped })).toBe(mapped);
  });

  it("returns null when no mapping exists", () => {
    expect(resolveRecipientEthAddress(fullParty, {})).toBeNull();
  });
});
