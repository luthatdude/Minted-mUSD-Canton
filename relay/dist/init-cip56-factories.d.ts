/**
 * Initialize CIP-56 Factory Contracts on Canton
 *
 * Creates MUSDTransferFactory and MUSDAllocationFactory if they don't already
 * exist. Idempotent — safe to run multiple times.
 *
 * Required env vars:
 *   CANTON_PARTY          — operator party ID
 *   CANTON_PACKAGE_ID     — main protocol DAR package ID
 *   CIP56_PACKAGE_ID      — ble-protocol-cip56 DAR package ID
 *
 * Usage:
 *   cd relay && npx ts-node --skip-project init-cip56-factories.ts
 */
export {};
//# sourceMappingURL=init-cip56-factories.d.ts.map