tolk 1.5.0

// One-time, hash-bound installer for complete runtime code and storage DAGs.
// Every step is an internal message committed by the previous step's hash.

import "@stdlib/common.tolk";
import "@stdlib/gas-payments.tolk";

const STAGED_INSTALLER_MAGIC: uint32 = 0x50424931; // 'PBI1'
import "@gen/op/deploy";

const INSTALL_KIND_FRAGMENT: uint8 = 1;
const INSTALL_KIND_NODE: uint8 = 2;
const INSTALL_KIND_FINALIZE: uint8 = 3;
const INSTALL_MIN_VALUE: coins = 20000000; // 0.02 GRAM
const INSTALL_STORAGE_RESERVE: coins = 100000000; // 0.1 GRAM
const INSTALL_MAX_STEPS: uint32 = 24;

const ERR_INSTALL_DATA: int = 2901;
const ERR_INSTALL_MESSAGE: int = 2902;
const ERR_INSTALL_VALUE: int = 2903;
const ERR_INSTALL_CHAIN: int = 2904;
const ERR_INSTALL_STEP: int = 2905;
const ERR_INSTALL_FRAGMENT: int = 2906;
const ERR_INSTALL_NODE: int = 2907;
const ERR_INSTALL_FINALIZE: int = 2908;

struct InstallerStorage {
    nextStep: uint32;
    totalSteps: uint32;
    expectedCodeHash: uint256;
    expectedDataHash: uint256;
    nextActionHash: uint256;
    lastActionHash: uint256;
    nodes: map<uint256, cell>;
}

fun load_storage(): InstallerStorage {
    var cursor = contract.getData().beginParse();
    assert (cursor.remainingBitsCount() >= 864 && cursor.remainingRefsCount() >= 1) throw ERR_INSTALL_DATA;
    assert (cursor.loadUint(32) == STAGED_INSTALLER_MAGIC) throw ERR_INSTALL_DATA;
    val nextStep = cursor.loadUint(32) as uint32;
    val totalSteps = cursor.loadUint(32) as uint32;
    val expectedCodeHash = cursor.loadUint(256) as uint256;
    val expectedDataHash = cursor.loadUint(256) as uint256;
    val nextActionHash = cursor.loadUint(256) as uint256;
    var history = cursor.loadRef().beginParse();
    assert (history.remainingBitsCount() == 256 && history.remainingRefsCount() == 0) throw ERR_INSTALL_DATA;
    val lastActionHash = history.loadUint(256) as uint256;
    val nodes = createMapFromLowLevelDict<uint256, cell>(cursor.loadDict());
    assert (cursor.remainingBitsCount() == 0 && cursor.remainingRefsCount() == 0) throw ERR_INSTALL_DATA;
    assert (totalSteps > 0 && totalSteps <= INSTALL_MAX_STEPS && nextStep < totalSteps) throw ERR_INSTALL_DATA;
    return InstallerStorage {
        nextStep,
        totalSteps,
        expectedCodeHash,
        expectedDataHash,
        nextActionHash,
        lastActionHash,
        nodes,
    };
}

fun save_storage(storage: InstallerStorage) {
    val history = beginCell()
        .storeUint(storage.lastActionHash, 256)
        .endCell();
    val data = beginCell()
        .storeUint(STAGED_INSTALLER_MAGIC, 32)
        .storeUint(storage.nextStep, 32)
        .storeUint(storage.totalSteps, 32)
        .storeUint(storage.expectedCodeHash, 256)
        .storeUint(storage.expectedDataHash, 256)
        .storeUint(storage.nextActionHash, 256)
        .storeRef(history)
        .storeDict(storage.nodes.toLowLevelDict())
        .endCell();
    contract.setData(data);
}

fun store_progress(storage: InstallerStorage, actionHash: uint256, nextActionHash: uint256): InstallerStorage {
    storage.lastActionHash = actionHash;
    storage.nextActionHash = nextActionHash;
    storage.nextStep += 1;
    save_storage(storage);
    reserveGramsOnBalance(INSTALL_STORAGE_RESERVE, 0);
    return storage;
}

fun require_action_tail(cursor: slice, expectedRefs: int) {
    assert (cursor.remainingBitsCount() == 0 && cursor.remainingRefsCount() == expectedRefs) throw ERR_INSTALL_MESSAGE;
}

fun append_child(builder: builder, nodes: map<uint256, cell>, childHash: uint256): builder {
    val lookup = nodes.get(childHash);
    assert (lookup.isFound) throw ERR_INSTALL_NODE;
    return builder.storeRef(lookup.loadValue());
}

fun apply_fragment(
    storage: InstallerStorage,
    action: slice,
    actionHash: uint256,
    nextActionHash: uint256,
): InstallerStorage {
    assert (action.remainingBitsCount() == 256 && action.remainingRefsCount() == 1) throw ERR_INSTALL_FRAGMENT;
    val expectedHash = action.loadUint(256) as uint256;
    val fragment = action.loadRef();
    assert (fragment.hash() == expectedHash) throw ERR_INSTALL_FRAGMENT;
    storage.nodes = storage.nodes.set(expectedHash, fragment);
    return store_progress(storage, actionHash, nextActionHash);
}

fun apply_node(
    storage: InstallerStorage,
    action: slice,
    actionHash: uint256,
    nextActionHash: uint256,
): InstallerStorage {
    assert (action.remainingBitsCount() == 259 && action.remainingRefsCount() == 2) throw ERR_INSTALL_NODE;
    val expectedHash = action.loadUint(256) as uint256;
    val refCount = action.loadUint(3);
    assert (refCount <= 4) throw ERR_INSTALL_NODE;
    val bitsCell = action.loadRef();
    var hashesCell = action.loadRef();
    var bits = bitsCell.beginParse();
    assert (bits.remainingRefsCount() == 0) throw ERR_INSTALL_NODE;
    var nodeBuilder = beginCell().storeSlice(bits);

    var childIndex = 0;
    while (childIndex < refCount) {
        var hashes = hashesCell.beginParse();
        assert (hashes.remainingBitsCount() == 256) throw ERR_INSTALL_NODE;
        val childHash = hashes.loadUint(256) as uint256;
        nodeBuilder = append_child(nodeBuilder, storage.nodes, childHash);
        childIndex += 1;
        if (childIndex < refCount) {
            assert (hashes.remainingRefsCount() == 1) throw ERR_INSTALL_NODE;
            hashesCell = hashes.loadRef();
        } else {
            assert (hashes.remainingRefsCount() == 0) throw ERR_INSTALL_NODE;
        }
    }

    val node = nodeBuilder.endCell();
    assert (node.hash() == expectedHash) throw ERR_INSTALL_NODE;
    storage.nodes = storage.nodes.set(expectedHash, node);
    return store_progress(storage, actionHash, nextActionHash);
}

fun apply_finalize(
    storage: InstallerStorage,
    action: slice,
    actionHash: uint256,
    nextActionHash: uint256,
) {
    assert (nextActionHash == 0) throw ERR_INSTALL_FINALIZE;
    assert (storage.nextStep + 1 == storage.totalSteps) throw ERR_INSTALL_FINALIZE;
    assert (action.remainingBitsCount() == 0 && action.remainingRefsCount() == 0) throw ERR_INSTALL_FINALIZE;
    val dataLookup = storage.nodes.get(storage.expectedDataHash);
    assert (dataLookup.isFound) throw ERR_INSTALL_FINALIZE;
    val finalData = dataLookup.loadValue();
    assert (finalData.hash() == storage.expectedDataHash) throw ERR_INSTALL_FINALIZE;
    val codeLookup = storage.nodes.get(storage.expectedCodeHash);
    assert (codeLookup.isFound) throw ERR_INSTALL_FINALIZE;
    val runtimeCode = codeLookup.loadValue();
    assert (runtimeCode.hash() == storage.expectedCodeHash) throw ERR_INSTALL_FINALIZE;

    // Both changes are reverted if the action phase fails.
    contract.setData(finalData);
    contract.setCodePostponed(runtimeCode);
    reserveGramsOnBalance(INSTALL_STORAGE_RESERVE, 0);
}

fun onInternalMessage(in: InMessage) {
    if (in.body.isEmpty()) {
        return;
    }
    assert (in.valueCoins >= INSTALL_MIN_VALUE) throw ERR_INSTALL_VALUE;

    var body = in.body;
    assert (body.remainingBitsCount() == 32 && body.remainingRefsCount() == 1) throw ERR_INSTALL_MESSAGE;
    assert (body.loadUint(32) == OP_INSTALLER_STEP) throw ERR_INSTALL_MESSAGE;
    val actionCell = body.loadRef();
    val actionHash = actionCell.hash();

    var storage = load_storage();
    if (actionHash == storage.lastActionHash && actionHash != 0) {
        reserveGramsOnBalance(INSTALL_STORAGE_RESERVE, 0);
        return;
    }
    assert (actionHash == storage.nextActionHash) throw ERR_INSTALL_CHAIN;

    var action = actionCell.beginParse();
    assert (action.remainingBitsCount() >= 296) throw ERR_INSTALL_MESSAGE;
    val kind = action.loadUint(8) as uint8;
    val step = action.loadUint(32) as uint32;
    val nextActionHash = action.loadUint(256) as uint256;
    assert (step == storage.nextStep) throw ERR_INSTALL_STEP;

    if (kind == INSTALL_KIND_FRAGMENT) {
        apply_fragment(storage, action, actionHash, nextActionHash);
        return;
    }
    if (kind == INSTALL_KIND_NODE) {
        apply_node(storage, action, actionHash, nextActionHash);
        return;
    }
    if (kind == INSTALL_KIND_FINALIZE) {
        apply_finalize(storage, action, actionHash, nextActionHash);
        return;
    }
    throw ERR_INSTALL_MESSAGE;
}

get fun bootstrap_state(): (uint32, uint32, uint256, uint256, uint256, uint256) {
    val storage = load_storage();
    return (
        storage.nextStep,
        storage.totalSteps,
        storage.expectedCodeHash,
        storage.expectedDataHash,
        storage.nextActionHash,
        storage.lastActionHash,
    );
}
