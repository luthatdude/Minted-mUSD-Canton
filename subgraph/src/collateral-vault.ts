import {
  Deposited as DepositedEv,
  Withdrawn as WithdrawnEv,
  Seized as SeizedEv,
} from "../generated/CollateralVault/CollateralVault";
import { CollateralDeposit, CollateralWithdrawal } from "../generated/schema";
import { generateEventId } from "./helpers";

export function handleDeposited(event: DepositedEv): void {
  let id = generateEventId(
    event.transaction.hash.toHexString(),
    event.logIndex.toString()
  );
  let entity = new CollateralDeposit(id);
  entity.user = event.params.user;
  entity.token = event.params.token;
  entity.amount = event.params.amount;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleWithdrawn(event: WithdrawnEv): void {
  let id = generateEventId(
    event.transaction.hash.toHexString(),
    event.logIndex.toString()
  );
  let entity = new CollateralWithdrawal(id);
  entity.user = event.params.user;
  entity.token = event.params.token;
  entity.amount = event.params.amount;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleSeized(event: SeizedEv): void {
  // Seizure = forced withdrawal during liquidation — track as withdrawal
  let id = generateEventId(
    event.transaction.hash.toHexString(),
    event.logIndex.toString()
  );
  let entity = new CollateralWithdrawal(id);
  entity.user = event.params.user;
  entity.token = event.params.token;
  entity.amount = event.params.amount;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}
