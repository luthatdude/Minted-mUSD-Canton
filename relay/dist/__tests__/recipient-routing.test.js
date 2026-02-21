"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const recipient_routing_1 = require("../recipient-routing");
const ethers_1 = require("ethers");
describe("parseRecipientPartyAliases", () => {
    it("returns empty map for empty input", () => {
        expect((0, recipient_routing_1.parseRecipientPartyAliases)("", "CANTON_RECIPIENT_PARTY_ALIASES")).toEqual({});
    });
    it("parses valid JSON alias map", () => {
        const map = (0, recipient_routing_1.parseRecipientPartyAliases)(JSON.stringify({
            "dde6467edc610708573d717a53c7c396::12200d9a833bb01839aa0c236eb5fe18008bd21fa980873a0c463ba1866506b4af9e": "minted-user-7de39963::12203f16a8f4b26778d5c8c6847dc055acf5db91e0c5b0846de29ba5ea272ab2a0e4",
        }), "CANTON_RECIPIENT_PARTY_ALIASES");
        expect(Object.keys(map)).toHaveLength(1);
    });
    it("throws on invalid JSON", () => {
        expect(() => (0, recipient_routing_1.parseRecipientPartyAliases)("{bad json", "CANTON_RECIPIENT_PARTY_ALIASES")).toThrow("must be valid JSON object");
    });
    it("throws on non-object JSON", () => {
        expect(() => (0, recipient_routing_1.parseRecipientPartyAliases)("[]", "CANTON_RECIPIENT_PARTY_ALIASES")).toThrow("must be a JSON object");
    });
    it("throws when alias value is empty", () => {
        expect(() => (0, recipient_routing_1.parseRecipientPartyAliases)(JSON.stringify({ "minted-user-1": "" }), "CANTON_RECIPIENT_PARTY_ALIASES")).toThrow("must be a non-empty string");
    });
});
describe("resolveRecipientParty", () => {
    const foreign = "dde6467edc610708573d717a53c7c396::12200d9a833bb01839aa0c236eb5fe18008bd21fa980873a0c463ba1866506b4af9e";
    const local = "minted-user-7de39963::12203f16a8f4b26778d5c8c6847dc055acf5db91e0c5b0846de29ba5ea272ab2a0e4";
    it("returns direct alias when full party is mapped", () => {
        const out = (0, recipient_routing_1.resolveRecipientParty)(foreign, { [foreign]: local });
        expect(out).toBe(local);
    });
    it("returns hint alias when only party hint is mapped", () => {
        const out = (0, recipient_routing_1.resolveRecipientParty)(foreign, {
            dde6467edc610708573d717a53c7c396: local,
        });
        expect(out).toBe(local);
    });
    it("prefers direct alias over hint alias", () => {
        const directLocal = "minted-user-direct::12203f16a8f4b26778d5c8c6847dc055acf5db91e0c5b0846de29ba5ea272ab2a0e4";
        const out = (0, recipient_routing_1.resolveRecipientParty)(foreign, {
            [foreign]: directLocal,
            dde6467edc610708573d717a53c7c396: local,
        });
        expect(out).toBe(directLocal);
    });
    it("returns original recipient when no alias matches", () => {
        const out = (0, recipient_routing_1.resolveRecipientParty)(foreign, {});
        expect(out).toBe(foreign);
    });
});
describe("parseRecipientEthAddresses", () => {
    it("returns empty map for empty input", () => {
        expect((0, recipient_routing_1.parseRecipientEthAddresses)("", "CANTON_REDEMPTION_ETH_RECIPIENTS")).toEqual({});
    });
    it("parses valid address map and normalizes checksum", () => {
        const map = (0, recipient_routing_1.parseRecipientEthAddresses)(JSON.stringify({
            "minted-user-33f97321": "0x33f97321214b5b8443f6212a05836c8ffe42dda5",
        }), "CANTON_REDEMPTION_ETH_RECIPIENTS");
        expect(map["minted-user-33f97321"]).toBe(ethers_1.ethers.getAddress("0x33f97321214b5b8443f6212a05836c8ffe42dda5"));
    });
    it("throws when address is invalid", () => {
        expect(() => (0, recipient_routing_1.parseRecipientEthAddresses)(JSON.stringify({ "minted-user-1": "not-an-address" }), "CANTON_REDEMPTION_ETH_RECIPIENTS")).toThrow("must be a valid Ethereum address");
    });
});
describe("resolveRecipientEthAddress", () => {
    const fullParty = "minted-user-33f97321::12203f16a8f4b26778d5c8c6847dc055acf5db91e0c5b0846de29ba5ea272ab2a0e4";
    const mapped = "0x33f97321214b5B8443f6212a05836C8fFE42DdA5";
    it("returns direct mapping when full party is present", () => {
        expect((0, recipient_routing_1.resolveRecipientEthAddress)(fullParty, { [fullParty]: mapped })).toBe(mapped);
    });
    it("falls back to party hint mapping", () => {
        expect((0, recipient_routing_1.resolveRecipientEthAddress)(fullParty, { "minted-user-33f97321": mapped })).toBe(mapped);
    });
    it("returns null when no mapping exists", () => {
        expect((0, recipient_routing_1.resolveRecipientEthAddress)(fullParty, {})).toBeNull();
    });
});
//# sourceMappingURL=recipient-routing.test.js.map