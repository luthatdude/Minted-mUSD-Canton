// ═══════════════════════════════════════════════════════════════
// MUSD — Transfer Event Handler (Supply Tracking)
// ═══════════════════════════════════════════════════════════════

import { Address } from "@graphprotocol/graph-ts";
import { Transfer } from "../generated/MUSD/MUSD";
import {
  getOrCreateProtocolStats,
  getOrCreateDailySnapshot,
  getOrCreateHourlySnapshot,
  toWadDecimal,
  ZERO_BD,
} from "./helpers";

const ZERO_ADDRESS = Address.fromString("0x0000000000000000000000000000000000000000");

export function handleMUSDTransfer(event: Transfer): void {
  let stats = getOrCreateProtocolStats();
  let amount = toWadDecimal(event.params.value);

  // Mint: from zero address
  if (event.params.from.equals(ZERO_ADDRESS)) {
    stats.musdTotalSupply = stats.musdTotalSupply.plus(amount);
  }

  // Burn: to zero address
  if (event.params.to.equals(ZERO_ADDRESS)) {
    stats.musdTotalSupply = stats.musdTotalSupply.minus(amount);
    if (stats.musdTotalSupply.lt(ZERO_BD)) {
      stats.musdTotalSupply = ZERO_BD;
    }
  }

  stats.lastUpdatedBlock = event.block.number;
  stats.lastUpdatedTimestamp = event.block.timestamp;
  stats.save();

  // Snapshot supply
  let daily = getOrCreateDailySnapshot(event.block.timestamp);
  daily.musdSupply = stats.musdTotalSupply;
  daily.save();

  let hourly = getOrCreateHourlySnapshot(event.block.timestamp);
  hourly.musdSupply = stats.musdTotalSupply;
  hourly.save();
}
