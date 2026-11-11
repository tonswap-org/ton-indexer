// The single list of compile targets. Names are the contract names tests pass to compile().

export const DEPLOY_TARGETS = {
    T3Wallet: 'contracts/t3/wallet.tolk',
    T3Hub: 'contracts/t3/hub.tolk',
    T3RecoveryProof: 'contracts/t3/recovery_proof.tolk',
    // Vendored upstream sources, pinned by contracts/vendor/jetton-v2.1/PROVENANCE.json.
    JettonV21Wallet: 'contracts/vendor/jetton-v2.1/JettonWallet.tolk',
    JettonV21Minter: 'contracts/vendor/jetton-v2.1/JettonMinter.tolk',
    TestnetFaucet: 'contracts/testnet/faucet.tolk',
    GasVault: 'contracts/automation/gas_vault.tolk',
    Treasury: 'contracts/governance/treasury.tolk',
    MerkleClaim: 'contracts/governance/merkle_claim.tolk',
    GenesisDistributor: 'contracts/governance/genesis_distributor.tolk',
    Remint: 'contracts/governance/remint.tolk',
    Governance: 'contracts/governance/governance.tolk',
    FeeRouter: 'contracts/treasury/fee_router.tolk',
    BuybackExecutor: 'contracts/treasury/buyback_executor.tolk',
    SwapCoordinator: 'contracts/dex/swap_coordinator.tolk',
    SpotOrder: 'contracts/dex/spot_order.tolk',
    SpotOrderFactory: 'contracts/dex/spot_order_factory.tolk',
    SaleFactory: 'contracts/launchpad/sale_factory.tolk',
    SaleFixed: 'contracts/launchpad/sale_fixed.tolk',
    SaleBonding: 'contracts/launchpad/sale_bonding.tolk',
    SaleAuction: 'contracts/launchpad/sale_auction.tolk',
    LpVault: 'contracts/launchpad/lp_vault.tolk',
    VestingVault: 'contracts/launchpad/vesting_vault.tolk',
    ReferralRegistry: 'contracts/referral/registry.tolk',
    EmissionsSplitter: 'contracts/referral/emissions_splitter.tolk',
    OptionFactory: 'contracts/options/factory.tolk',
    OptionSeriesManager: 'contracts/options/series_manager.tolk',
    OptionVault: 'contracts/options/vault.tolk',
    ShoutOption: 'contracts/options/shout_option.tolk',
    OutperformanceOption: 'contracts/options/outperformance_option.tolk',
    RiskVault: 'contracts/risk/risk_vault.tolk',
    PerpsEngine: 'contracts/perps/engine.tolk',
    // Generic hash-chained staged installer used for every StateInit too large for one message.
    StagedInstaller: 'contracts/shared/deploy/staged_installer.tolk',
    ParisianPolicyManager: 'contracts/cover/policy_manager.tolk',
    CoverVault: 'contracts/cover/cover_vault.tolk',
    DlmmPool: 'contracts/dlmm/pool.tolk',
    DlmmPoolFactory: 'contracts/dlmm/pool_factory.tolk',
    CoverAutomationUpkeep: 'contracts/automation/cover_automation_upkeep.tolk',
} as const;

export const TEST_TARGETS = {
    SpotOrderMockPool: 'contracts/testing/spot_order_mock_pool.tolk',
    DlmmBookHarness: 'contracts/testing/dlmm_book_harness.tolk',
    DlmmWireHarness: 'contracts/testing/dlmm_wire_harness.tolk',
    HostileJettonMinter: 'contracts/testing/hostile_jetton_minter.tolk',
    HostileJettonWallet: 'contracts/testing/hostile_jetton_wallet.tolk',
    JettonSweepHarness: 'contracts/testing/jetton_sweep_harness.tolk',
    JettonSlotHarness: 'contracts/testing/jetton_slot_harness.tolk',
    BounceWallet: 'contracts/testing/bounce_wallet.tolk',
    CounterpartyHarness: 'contracts/testing/counterparty_harness.tolk',
    FullMathHarness: 'contracts/testing/full_math_harness.tolk',
    FundingRejector: 'contracts/testing/funding_rejector.tolk',
    ModuleGateHarness: 'contracts/testing/module_gate_harness.tolk',
    ObsRingHarness: 'contracts/testing/obs_ring_harness.tolk',
    OraclePoolStub: 'contracts/testing/oracle_pool_stub.tolk',
    PerpsFundingHarness: 'contracts/testing/perps_funding_harness.tolk',
    PolicyTypesHarness: 'contracts/testing/policy_types_harness.tolk',
    SerializationHarness: 'contracts/testing/serialization_harness.tolk',
    SwapPayloadHarness: 'contracts/testing/swap_payload_harness.tolk',
    TepJettonCodecHarness: 'contracts/testing/tep_jetton_codec_harness.tolk',
    VerdictHarness: 'contracts/testing/verdict_harness.tolk',
    WrapperTemplateExample: 'contracts/testing/wrapper_template_example.tolk',
} as const;

export type DeployTarget = keyof typeof DEPLOY_TARGETS;
export type Target = DeployTarget | keyof typeof TEST_TARGETS;

export const TARGETS: Record<Target, string> = { ...DEPLOY_TARGETS, ...TEST_TARGETS };
