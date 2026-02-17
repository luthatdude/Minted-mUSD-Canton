import { GlobalPauseStateChanged } from "../../generated/GlobalPauseRegistry/GlobalPauseRegistry";
import { GlobalPauseEvent } from "../../generated/schema";

export function handleGlobalPauseStateChanged(
  event: GlobalPauseStateChanged
): void {
  let id =
    event.transaction.hash.toHexString() +
    "-" +
    event.logIndex.toString();
  let entity = new GlobalPauseEvent(id);
  entity.paused = event.params.paused;
  entity.caller = event.params.caller;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}
