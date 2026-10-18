tolk 1.5.0

// A real compute-phase rejection; TVM emits the bounce and rolls back delivery.
fun onInternalMessage(_: InMessage) {
    throw 3333;
}

fun onBouncedMessage(_: InMessageBounced) {}
