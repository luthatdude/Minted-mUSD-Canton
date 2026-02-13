import {
  Minted as MintedEv,
  Redeemed as RedeemedEv,
} from "../generated/DirectMintV2/DirectMintV2";
import { DirectMint, DirectRedeem } from "../generated/schema";
import { generateEventId } from "./helpers";

export function handleMinted(event: MintedEv): void {
  let id = generateEventId(
    event.transaction.hash.toHexString(),
    event.logIndex.toString()
  );
  let entity = new DirectMint(id);
  entity.user = event.params.user;
  entity.usdcAmount = event.params.usdcIn;
  entity.musdAmount = event.params.musdOut;
  entity.fee = event.params.fee;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}

export function handleRedeemed(event: RedeemedEv): void {
  let id = generateEventId(
    event.transaction.hash.toHexString(),
    event.logIndex.toString()
  );
  let entity = new DirectRedeem(id);
  entity.user = event.params.user;
  entity.musdAmount = event.params.musdIn;
  entity.usdcAmount = event.params.usdcOut;
  entity.fee = event.params.fee;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}
