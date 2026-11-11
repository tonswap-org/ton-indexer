tolk 1.5.0
import "../generated/op/options";

struct (0x4f564259) OvBuy { queryId: uint64; seriesId: uint64; notional: coins }
struct (0x4f564644) OvFund { queryId: uint64; seriesId: uint64 }
struct (0x4f564144) OvAdmit { intentId: uint64; kind: uint8; from: address; amount: coins; seriesId: uint64; notional: coins }
struct (0x4f56434d) OvCommit { intentId: uint64; kind: uint8; seriesId: uint64; net: coins; fee: coins; lock: coins; expiry: uint32 }
struct (0x4f56524a) OvReject { intentId: uint64; reason: uint16 }
struct (0x4f565850) OvExpire { queryId: uint64; intentId: uint64 }
struct (0x4f564351) OvCancel { intentId: uint64; kind: uint8; seriesId: uint64 }
struct (0x4f565354) OvSettle { seriesId: uint64; tokenId: uint64; holder: address; payout: coins }
struct (0x56524644) VoidRefund { queryId: uint64; seriesId: uint64; tokenId: uint64; holder: address }
struct (0x4f584259) OxBuy { tokenId: uint64; owner: address; notional: coins; net: coins; lock: coins }
struct (0x4f584241) OxBuyOk { seriesId: uint64; tokenId: uint64 }
struct (0x4f58424e) OxBuyNo { seriesId: uint64; tokenId: uint64; reason: uint16 }
struct (0x4f584258) OxBuyAbort { tokenId: uint64 }
struct (0x4f585351) OxSettleQ { tokenId: uint64; caller: address; minPayout: coins }
struct (0x4f585352) OxSettleR { seriesId: uint64; tokenId: uint64; caller: address; status: uint2; holder: address; payout: coins }
struct (0x4f584353) OxShoutCfg {
    writer: address; pool: address; expiry: uint32; cooldownSeconds: uint32;
    floorWindowSeconds: uint32; maxNotional: coins; strikeBps: uint32; collateralMultiplierBps: uint32;
}
struct (0x4f58434f) OxOutperfCfg {
    writer: address; basePool: address; quotePool: address; expiry: uint32;
    maxNotional: coins; collateralMultiplierBps: uint32;
}
struct (0x4f4d4353) OmCreate { queryId: uint64; templateId: uint32; maxNotional: coins; writer: address }
struct OptionPools { base: address; quote: address? }
struct (0x4f534352) OsCreate {
    seriesId: uint64; kind: uint16; expiry: uint32; maxNotional: coins;
    premiumBps: uint32; collateralMultiplierBps: uint32; strikeBps: uint32;
    writer: address; pools: Cell<OptionPools>;
}
struct (0x4f535253) OsResend { queryId: uint64; seriesId: uint64 }
struct (0x4f465047) OfPurge { queryId: uint64; seriesId: uint64 }
struct (0x4f464558) OfExercise { queryId: uint64; seriesId: uint64; tokenId: uint64; minPayout: coins }
struct (0x4f564346) OvConfig { queryId: uint64; factory: address }
struct (0x4f464346) OfConfig { queryId: uint64; manager: address }
struct (0x4f464545) OfFee { queryId: uint64; protocolFeeBps: uint16 }
struct (0x4f564556) OvEvent { queryId: uint64; kind: uint8; seriesId: uint64; tokenId: uint64; intentId: uint64; amount: coins; party: address }
struct (0x4f534544) OptionSeed { queryId: uint64 }
struct (0x4f53544c) OptionSettle { queryId: uint64; side: uint1 }
struct (0x4f434150) OptionSetCap { queryId: uint64; cap: coins }
struct (0x53484f55) Shout { tokenId: uint64 }
struct (0x46455843) FactoryExercise { seriesId: uint64; tokenId: uint64 }
struct (0x4f535757) WriterWithdraw { queryId: uint64; seriesId: uint64; amount: coins }
@overflow1023_policy("suppress")
struct (0x52544d50) RegisterTemplate {
    templateId: uint32; optionKind: uint16; underlyingPool: any_address; quotePool: any_address;
    tenorSeconds: int64; strikeBps: uint32; collateralMultiplierBps: uint32; basePremiumBps: uint32;
}
struct (0x55544d50) UpdateTemplate {
    templateId: uint32; tenorSeconds: int64; strikeBps: uint32; collateralMultiplierBps: uint32; basePremiumBps: uint32;
}
struct (0x53554744) SetUtilisationGuard { bumpActivateBps: uint16; bumpDeactivateBps: uint16; pauseThresholdBps: uint16; bumpPercentBps: uint16 }
struct (0x53434d54) SetCollateralMultiplier { optionKind: uint16; multiplierBps: uint32 }

struct (0x4f54524d) OptionTerminal { seriesId: uint64; state: uint2; window: uint16; decidedAt: uint64; priceE9: uint128; quotePriceE9: uint128 }

// Capacity leaves the factory before the vault pays withdrawn backing.
struct (0x4f575251) OptionWithdrawRequest { seriesId: uint64; cumulativeBacking: coins }
struct (0x4f57414b) OptionWithdrawAck { seriesId: uint64; cumulativeBacking: coins }
struct (0x4f575253) OptionWithdrawResend { queryId: uint64; seriesId: uint64 }
