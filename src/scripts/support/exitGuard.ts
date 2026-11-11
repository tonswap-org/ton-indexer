/**
 * Makes a test script fail unless it reports completion. A script whose cleanup
 * awaits work that never settles drains the event loop without reaching its
 * catch, and Node then exits 0. The guard holds exit code 1 from the start and
 * releases it only when the script calls done() after its last check.
 */
export function exitGuard(name: string) {
  let completed = false;
  process.exitCode = 1;
  process.once('exit', () => {
    if (!completed) {
      process.exitCode = 1;
      console.error(`${name} ended before it completed`);
    }
  });
  return {
    done() {
      completed = true;
      process.exitCode = 0;
    },
  };
}
