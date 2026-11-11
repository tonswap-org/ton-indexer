# Retained retired worker evidence

The current PxStorage release has no `open_order_preflight` or `close_order_preflight` ABI. Its browser uses current intake and funding getters through the pinned liteserver read path. The obsolete worker implementation, source patch, build verifier and executable tests have been removed from the active tree. No current startup, health, ledger qualification or historical replay depends on this directory.

Original proof BOCs, provenance, the original source lock and historical `ADMISSION.md` remain unchanged here as evidence. They describe the retired implementation, not current build instructions or a qualified current release. The implementation can be recovered from Git before its removal. Preserve separately retained native packages, source/build receipts, configuration and live recordings under the owning repository's `.local/`; none are deleted or modified by this change.

Current account/configuration proof verification and exact historical replay remain in `src/data/`, with their own ordinary tests. Run the current release gates documented in the repository README.
