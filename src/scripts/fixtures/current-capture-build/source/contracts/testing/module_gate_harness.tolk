tolk 1.5.0

// testing/module_gate_harness.tolk
// The smallest pausable module: one operation that adds risk, one exit and one governed setting,
// each counting its calls, wired to shared/governance/module_gate.tolk the way a module wires it.
// Its own messages are one byte, so the harness needs no tag of the registry.

import "../shared/governance/module_gate.tolk";

struct Storage {
    gate: ModuleGate;
    risk: uint32;
    exits: uint32;
    setting: uint32;
}

struct (0x01) AddRisk {}

struct (0x02) Exit {}

struct (0x03) Configure {
    setting: uint32;
}

type ModuleMessage = AddRisk | Exit | Configure;

fun onInternalMessage(in: InMessage) {
    if (in.body.isEmpty()) {
        return;
    }
    var storage = Storage.fromCell(contract.getData());
    if (!gate_handle(mutate storage.gate, in.senderAddress, in.body)) {
        val msg = ModuleMessage.fromSlice(in.body);
        match (msg) {
            AddRisk => {
                gate_require_open(storage.gate);
                storage.risk += 1;
            }
            // An exit never asks the gate.
            Exit => {
                storage.exits += 1;
            }
            // Governed settings stay available while the module is closed.
            Configure => {
                gate_require_governance(storage.gate, in.senderAddress);
                storage.setting = msg.setting;
            }
        }
    }
    contract.setData(storage.toCell());
}

get fun get_gate(): ModuleGate {
    return Storage.fromCell(contract.getData()).gate;
}

get fun get_counters(): (uint32, uint32, uint32) {
    val storage = Storage.fromCell(contract.getData());
    return (storage.risk, storage.exits, storage.setting);
}
