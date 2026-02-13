import {
  Borrowed as BorrowedEv,
  Repaid as RepaidEv,
  GlobalInterestAccrued as GlobalInterestAccruedEv,
} from "../generated/BorrowModule/BorrowModule";
import { BorrowEvent, RepayEvent } from "../generated/schema";
import { generateEventId, getOrCreateProtocolStats } from "./helpers";

export function handleBorrowed(event: BorrowedEv): void {
  let id = generateEventId(
    event.transaction.hash.toHexString(),
    event.logIndex.toString()
  );
  let entity = new BorrowEvent(id);
  entity.user = event.params.user;
  entity.amount = event.params.amount;
  entity.totalDebt = event.params.totalDebt;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  let stats = getOrCreateProtocolStats();
  stats.totalBorrows = event.params.totalDebt;
  stats.lastUpdatedBlock = event.block.number;
  stats.save();
}

export function handleRepaid(event: RepaidEv): void {
  let id = generateEventId(
    event.transaction.hash.toHexString(),
    event.logIndex.toString()
  );
  let entity = new RepayEvent(id);
  entity.user = event.params.user;
  entity.amount = event.params.amount;
  entity.remainingDebt = event.params.remaining;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleGlobalInterestAccrued(
  event: GlobalInterestAccruedEv
): void {
  let stats = getOrCreateProtocolStats();
  stats.totalBorrows = event.params.newTotalBorrows;
  stats.lastUpdatedBlock = event.block.number;
  stats.save();
}
