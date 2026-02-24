"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const canton_client_1 = require("../canton-client");
function jsonResponse(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
    };
}
function textErrorResponse(status, body) {
    return {
        ok: false,
        status,
        json: async () => {
            throw new Error("no-json");
        },
        text: async () => body,
    };
}
function makeActiveEntry(index, templateId) {
    return {
        contractEntry: {
            JsActiveContract: {
                createdEvent: {
                    contractId: `#${index}`,
                    templateId,
                    createArgument: { index },
                    createdAt: "2026-02-20T00:00:00.000Z",
                    offset: index,
                    signatories: [],
                    observers: [],
                },
            },
        },
    };
}
function makeClient() {
    return new canton_client_1.CantonClient({
        baseUrl: "http://localhost:7575",
        token: "test-token",
        userId: "administrator",
        actAs: "minted-validator-1::1220abc",
        defaultPackageId: "pkg-test",
        timeoutMs: 1000,
    });
}
describe("CantonClient queryContracts overflow fallback", () => {
    const originalFetch = global.fetch;
    beforeEach(() => {
        jest.spyOn(console, "warn").mockImplementation(() => { });
    });
    afterEach(() => {
        global.fetch = originalFetch;
        jest.restoreAllMocks();
    });
    it("falls back to /v2/updates when active-contracts returns exactly limit=200", async () => {
        const client = makeClient();
        const targetTemplate = "pkg-test:Minted.Protocol.V3:AttestationRequest";
        global.fetch = jest.fn(async (input) => {
            const url = new URL(String(input));
            if (url.pathname === "/v2/state/ledger-end") {
                return jsonResponse({ offset: 500 });
            }
            if (url.pathname === "/v2/state/active-contracts") {
                return jsonResponse(Array.from({ length: 200 }, (_, i) => makeActiveEntry(i + 1, targetTemplate)));
            }
            if (url.pathname === "/v2/updates") {
                return jsonResponse([
                    {
                        update: {
                            Transaction: {
                                value: {
                                    offset: 101,
                                    events: [
                                        {
                                            CreatedEvent: {
                                                contractId: "cid-1",
                                                templateId: targetTemplate,
                                                createArgument: { nonce: 1 },
                                                createdAt: "2026-02-20T00:00:00.000Z",
                                                offset: 101,
                                                signatories: [],
                                                observers: [],
                                            },
                                        },
                                    ],
                                },
                            },
                        },
                    },
                    {
                        update: {
                            Transaction: {
                                value: {
                                    offset: 102,
                                    events: [
                                        {
                                            CreatedEvent: {
                                                contractId: "cid-2",
                                                templateId: targetTemplate,
                                                createArgument: { nonce: 2 },
                                                createdAt: "2026-02-20T00:00:01.000Z",
                                                offset: 102,
                                                signatories: [],
                                                observers: [],
                                            },
                                        },
                                    ],
                                },
                            },
                        },
                    },
                    {
                        update: {
                            Transaction: {
                                value: {
                                    offset: 103,
                                    events: [
                                        {
                                            ArchivedEvent: {
                                                contractId: "cid-1",
                                                offset: 103,
                                            },
                                        },
                                        {
                                            CreatedEvent: {
                                                contractId: "cid-other",
                                                templateId: "pkg-test:Minted.Protocol.V3:BridgeOutRequest",
                                                createArgument: { nonce: 99 },
                                                createdAt: "2026-02-20T00:00:02.000Z",
                                                offset: 103,
                                                signatories: [],
                                                observers: [],
                                            },
                                        },
                                    ],
                                },
                            },
                        },
                    },
                ]);
            }
            throw new Error(`unexpected URL: ${url.pathname}`);
        });
        const contracts = await client.queryContracts(canton_client_1.TEMPLATES.AttestationRequest);
        expect(contracts).toHaveLength(1);
        expect(contracts[0].contractId).toBe("cid-2");
        expect(global.fetch.mock.calls.some((args) => String(args[0]).includes("/v2/updates"))).toBe(true);
    });
    it("does not fallback when active-contracts returns 199 entries", async () => {
        const client = makeClient();
        const targetTemplate = "pkg-test:Minted.Protocol.V3:AttestationRequest";
        global.fetch = jest.fn(async (input) => {
            const url = new URL(String(input));
            if (url.pathname === "/v2/state/ledger-end") {
                return jsonResponse({ offset: 600 });
            }
            if (url.pathname === "/v2/state/active-contracts") {
                return jsonResponse(Array.from({ length: 199 }, (_, i) => makeActiveEntry(i + 1, targetTemplate)));
            }
            if (url.pathname === "/v2/updates") {
                throw new Error("updates endpoint should not be called for 199 entries");
            }
            throw new Error(`unexpected URL: ${url.pathname}`);
        });
        const contracts = await client.queryContracts(canton_client_1.TEMPLATES.AttestationRequest);
        expect(contracts).toHaveLength(199);
        expect(global.fetch.mock.calls.some((args) => String(args[0]).includes("/v2/updates"))).toBe(false);
    });
    it("falls back to /v2/updates on direct HTTP 413 from active-contracts", async () => {
        const client = makeClient();
        const targetTemplate = "pkg-test:Minted.Protocol.V3:AttestationRequest";
        let activeContractsCalls = 0;
        global.fetch = jest.fn(async (input) => {
            const url = new URL(String(input));
            if (url.pathname === "/v2/state/ledger-end") {
                return jsonResponse({ offset: 700 });
            }
            if (url.pathname === "/v2/state/active-contracts") {
                activeContractsCalls += 1;
                return textErrorResponse(413, "Payload Too Large");
            }
            if (url.pathname === "/v2/updates") {
                return jsonResponse([
                    {
                        update: {
                            Transaction: {
                                value: {
                                    offset: 701,
                                    events: [
                                        {
                                            CreatedEvent: {
                                                contractId: "cid-413",
                                                templateId: targetTemplate,
                                                createArgument: { nonce: 413 },
                                                createdAt: "2026-02-20T00:00:03.000Z",
                                                offset: 701,
                                                signatories: [],
                                                observers: [],
                                            },
                                        },
                                    ],
                                },
                            },
                        },
                    },
                ]);
            }
            throw new Error(`unexpected URL: ${url.pathname}`);
        });
        const contracts = await client.queryContracts(canton_client_1.TEMPLATES.AttestationRequest);
        expect(contracts).toHaveLength(1);
        expect(contracts[0].contractId).toBe("cid-413");
        expect(activeContractsCalls).toBe(1);
        expect(global.fetch.mock.calls.some((args) => String(args[0]).includes("/v2/updates"))).toBe(true);
    });
    it("throws CantonApiError when updates replay makes no offset progress", async () => {
        const client = makeClient();
        const targetTemplate = "pkg-test:Minted.Protocol.V3:AttestationRequest";
        global.fetch = jest.fn(async (input) => {
            const url = new URL(String(input));
            if (url.pathname === "/v2/state/ledger-end") {
                return jsonResponse({ offset: 800 });
            }
            if (url.pathname === "/v2/state/active-contracts") {
                return jsonResponse(Array.from({ length: 200 }, (_, i) => makeActiveEntry(i + 1, targetTemplate)));
            }
            if (url.pathname === "/v2/updates") {
                return jsonResponse([
                    {
                        update: {
                            Transaction: {
                                value: {
                                    offset: 0,
                                    events: [],
                                },
                            },
                        },
                    },
                ]);
            }
            throw new Error(`unexpected URL: ${url.pathname}`);
        });
        try {
            await client.queryContracts(canton_client_1.TEMPLATES.AttestationRequest);
            throw new Error("expected queryContracts to throw");
        }
        catch (error) {
            expect(error).toBeInstanceOf(canton_client_1.CantonApiError);
            expect(String(error.message)).toMatch(/No offset progress/);
        }
    });
    it("throws CantonApiError when updates replay exceeds max pages", async () => {
        const client = makeClient();
        const targetTemplate = "pkg-test:Minted.Protocol.V3:AttestationRequest";
        let updatesCalls = 0;
        global.fetch = jest.fn(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === "/v2/state/ledger-end") {
                return jsonResponse({ offset: 10000 });
            }
            if (url.pathname === "/v2/state/active-contracts") {
                return jsonResponse(Array.from({ length: 200 }, (_, i) => makeActiveEntry(i + 1, targetTemplate)));
            }
            if (url.pathname === "/v2/updates") {
                updatesCalls += 1;
                const body = init?.body ? JSON.parse(String(init.body)) : {};
                const beginExclusive = Number(body.beginExclusive || 0);
                const nextOffset = beginExclusive + 1;
                return jsonResponse(Array.from({ length: 50 }, () => ({
                    update: {
                        Transaction: {
                            value: {
                                offset: nextOffset,
                                events: [],
                            },
                        },
                    },
                })));
            }
            throw new Error(`unexpected URL: ${url.pathname}`);
        });
        try {
            await client.queryContracts(canton_client_1.TEMPLATES.AttestationRequest);
            throw new Error("expected queryContracts to throw");
        }
        catch (error) {
            expect(error).toBeInstanceOf(canton_client_1.CantonApiError);
            expect(String(error.message)).toMatch(/Exceeded max update pages/);
        }
        expect(updatesCalls).toBe(50);
    });
});
//# sourceMappingURL=canton-client-overflow.test.js.map