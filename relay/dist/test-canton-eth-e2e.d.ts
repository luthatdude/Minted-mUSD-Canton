/**
 * Canton ↔ Ethereum End-to-End Bridge Test
 *
 * This test verifies the complete Canton↔ETH bridge integration:
 *   1. Canton devnet connectivity + BLE Protocol contracts
 *   2. Canton BridgeService is live and queryable
 *   3. Ethereum (Sepolia) BLEBridgeV9 is reachable
 *   4. Round-trip: Create AttestationRequest on Canton → verify relayer can read it
 *   5. Round-trip: Verify BLEBridgeV9 nonce consistency with Canton BridgeService
 *
 * Prerequisites:
 *   - Canton devnet running: cd ~/splice-node/docker-compose/validator && docker compose up -d
 *   - Port-forward: docker run --rm -d --name canton-port-fwd \
 *       --network splice-validator_splice_validator -p 127.0.0.1:7575:7575 \
 *       alpine/socat TCP-LISTEN:7575,fork,reuseaddr TCP:participant:7575
 *   - BLE Protocol initialized: scripts/canton-init.sh
 *
 * Usage:
 *   NODE_ENV=development npx ts-node test-canton-eth-e2e.ts
 */
export {};
//# sourceMappingURL=test-canton-eth-e2e.d.ts.map