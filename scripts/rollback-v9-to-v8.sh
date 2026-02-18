#!/usr/bin/env bash
# ============================================================
# Minted Protocol — V9 → V8 Emergency Rollback Script
# ============================================================
#
# Item-11: Automated rollback drill corresponding to the
# "Emergency Rollback Steps" in MIGRATION_V8_TO_V9.md.
#
# This script reverses a V9 cutover back to V8 in the minimum
# number of transactions. Each step is timed and logged.
#
# Usage:
#   export DEPLOYER_KEY=0x...
#   export V8_BRIDGE=0x...
#   export V9_BRIDGE=0x...
#   export MUSD_ADDRESS=0x...
#   export RPC_URL=https://...
#   bash scripts/rollback-v9-to-v8.sh
#
# ============================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ROLLBACK_START=$(date +%s)

require_var() {
  if [[ -z "${!1:-}" ]]; then
    echo -e "${RED}ERROR: ${1} is required${NC}"
    exit 1
  fi
}

require_var "DEPLOYER_KEY"
require_var "V8_BRIDGE"
require_var "V9_BRIDGE"
require_var "MUSD_ADDRESS"
require_var "RPC_URL"

echo ""
echo -e "${YELLOW}╔══════════════════════════════════════════════╗${NC}"
echo -e "${YELLOW}║  EMERGENCY ROLLBACK: V9 → V8                ║${NC}"
echo -e "${YELLOW}╚══════════════════════════════════════════════╝${NC}"
echo ""

DEPLOYER_ADDR=$(node -e "
  const {ethers}=require('ethers');
  const w=new ethers.Wallet('$DEPLOYER_KEY');
  console.log(w.address);
" 2>/dev/null)
echo "Deployer: ${DEPLOYER_ADDR}"

# ── Step 1: Pause V9 ──
echo -e "\n${YELLOW}[1/6] Pausing V9...${NC}"
T1=$(date +%s)
node -e "
const {ethers}=require('ethers');
const p=new ethers.JsonRpcProvider('$RPC_URL');
const w=new ethers.Wallet('$DEPLOYER_KEY',p);
const c=new ethers.Contract('$V9_BRIDGE', ['function pause()','function paused() view returns (bool)'], w);
(async()=>{
  if(await c.paused()){console.log('Already paused');return;}
  const tx=await c.pause();
  const r=await tx.wait();
  console.log('Paused V9:',r.hash);
})();
" 2>/dev/null
echo -e "${GREEN}  Done ($(($(date +%s)-T1))s)${NC}"

# ── Step 2: Revoke V9 CAP_MANAGER_ROLE ──
echo -e "\n${YELLOW}[2/6] Revoking V9 CAP_MANAGER_ROLE on MUSD...${NC}"
T2=$(date +%s)
node -e "
const {ethers}=require('ethers');
const p=new ethers.JsonRpcProvider('$RPC_URL');
const w=new ethers.Wallet('$DEPLOYER_KEY',p);
const c=new ethers.Contract('$MUSD_ADDRESS',['function revokeRole(bytes32,address)'],w);
const role=ethers.keccak256(ethers.toUtf8Bytes('CAP_MANAGER_ROLE'));
c.revokeRole(role,'$V9_BRIDGE').then(tx=>tx.wait().then(r=>console.log('Revoked:',r.hash)));
" 2>/dev/null
echo -e "${GREEN}  Done ($(($(date +%s)-T2))s)${NC}"

# ── Step 3: Re-grant V8 BRIDGE_ROLE ──
echo -e "\n${YELLOW}[3/6] Re-granting V8 BRIDGE_ROLE on MUSD...${NC}"
T3=$(date +%s)
node -e "
const {ethers}=require('ethers');
const p=new ethers.JsonRpcProvider('$RPC_URL');
const w=new ethers.Wallet('$DEPLOYER_KEY',p);
const c=new ethers.Contract('$MUSD_ADDRESS',['function grantRole(bytes32,address)'],w);
const role=ethers.keccak256(ethers.toUtf8Bytes('BRIDGE_ROLE'));
c.grantRole(role,'$V8_BRIDGE').then(tx=>tx.wait().then(r=>console.log('Granted:',r.hash)));
" 2>/dev/null
echo -e "${GREEN}  Done ($(($(date +%s)-T3))s)${NC}"

# ── Step 4: Unpause V8 ──
echo -e "\n${YELLOW}[4/6] Unpausing V8...${NC}"
T4=$(date +%s)
node -e "
const {ethers}=require('ethers');
const p=new ethers.JsonRpcProvider('$RPC_URL');
const w=new ethers.Wallet('$DEPLOYER_KEY',p);
const c=new ethers.Contract('$V8_BRIDGE',['function unpause()','function paused() view returns (bool)'],w);
(async()=>{
  if(!(await c.paused())){console.log('Already unpaused');return;}
  const tx=await c.unpause();
  const r=await tx.wait();
  console.log('Unpaused V8:',r.hash);
})();
" 2>/dev/null
echo -e "${GREEN}  Done ($(($(date +%s)-T4))s)${NC}"

# ── Step 5: Print relay config update instructions ──
echo -e "\n${YELLOW}[5/6] Relay config update required:${NC}"
echo "  Update BRIDGE_CONTRACT_ADDRESS=${V8_BRIDGE}"
echo "  Restart relay and validator services"
echo "  (docker-compose restart relay validator1 validator2 validator3)"

# ── Step 6: Sync V8 nonce from V9 ──
echo -e "\n${YELLOW}[6/6] Syncing V8 nonce from V9...${NC}"
T6=$(date +%s)
node -e "
const {ethers}=require('ethers');
const p=new ethers.JsonRpcProvider('$RPC_URL');
const w=new ethers.Wallet('$DEPLOYER_KEY',p);
const v9=new ethers.Contract('$V9_BRIDGE',['function currentNonce() view returns (uint256)'],p);
const v8=new ethers.Contract('$V8_BRIDGE',['function forceUpdateNonce(uint256,string)'],w);
(async()=>{
  const nonce=await v9.currentNonce();
  console.log('V9 current nonce:',nonce.toString());
  if(Number(nonce)===0){console.log('No attestations on V9, skip nonce sync');return;}
  const tx=await v8.forceUpdateNonce(nonce,'Rollback nonce sync from V9');
  const r=await tx.wait();
  console.log('Nonce synced:',r.hash);
})();
" 2>/dev/null
echo -e "${GREEN}  Done ($(($(date +%s)-T6))s)${NC}"

ROLLBACK_END=$(date +%s)
TOTAL=$((ROLLBACK_END - ROLLBACK_START))

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  ROLLBACK COMPLETE — ${TOTAL}s total                ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo ""
echo "Post-rollback verification:"
echo "  1. curl http://127.0.0.1:8080/health  → should be 'ok'"
echo "  2. Check Grafana for attestation throughput"
echo "  3. Submit test attestation to V8"
echo "  4. Monitor for 1 hour before declaring stable"
