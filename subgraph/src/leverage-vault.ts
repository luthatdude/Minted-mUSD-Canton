import {
  LeverageOpened as LeverageOpenedEv,
  LeverageClosed as LeverageClosedEv,
} from "../generated/LeverageVault/LeverageVault";
import { LeverageOpen, LeverageClose } from "../generated/schema";
import { generateEventId } from "./helpers";

export function handleLeverageOpened(event: LeverageOpenedEv): void {
  let id = generateEventId(
    event.transaction.hash.toHexString(),
    event.logIndex.toString()
  );
  let entity = new LeverageOpen(id);
  entity.user = event.params.user;
  entity.collateralToken = event.params.collateralToken;
  entity.initialDeposit = event.params.initialDeposit;
  entity.totalCollateral = event.params.totalCollateral;
  entity.totalDebt = event.params.totalDebt;
  entity.loops = event.params.loopsExecuted.toI32();
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleLeverageClosed(event: LeverageClosedEv): void {
  let id = generateEventId(
    event.transaction.hash.toHexString(),
    event.logIndex.toString()
  );
  let entity = new LeverageClose(id);
  entity.user = event.params.user;
  entity.collateralReturned = event.params.collateralReturned;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}
