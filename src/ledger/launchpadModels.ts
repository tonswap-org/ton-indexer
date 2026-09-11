import type { Cell } from "@ton/core";

type LedgerLaunchpadPaymentRouting = {
  address: string;
  factory: string | null;
  paymentRoot: string;
  paymentWallet: string;
  paymentWalletCode: Cell;
  saleCodeHash: string;
};

export type LedgerLaunchpadFixedSale = LedgerLaunchpadPaymentRouting & { model: "fixed" };
export type LedgerLaunchpadBondingSale = LedgerLaunchpadPaymentRouting & { model: "bonding" };
export type LedgerLaunchpadAuctionSale = LedgerLaunchpadPaymentRouting & { model: "auction" };
export type LedgerLaunchpadSale = LedgerLaunchpadFixedSale | LedgerLaunchpadBondingSale | LedgerLaunchpadAuctionSale;
