/**
 * Solidity-coverage configuration.
 *
 * The instrumentation pass injects bookkeeping variables into every function,
 * which pushes complex contracts past the 16-slot EVM stack limit.
 * `configureYulOptimizer: true` tells the plugin to enable the Yul optimizer
 * with `stackAllocation: true` so the compiler can spill to memory.
 *
 * `skipFiles` excludes mock contracts and test helpers whose coverage
 * numbers are meaningless noise.
 */
module.exports = {
  configureYulOptimizer: true,
  solcOptimizerDetails: {
    yul: true,
    yulDetails: {
      stackAllocation: true,
      optimizerSteps: "u",
    },
  },
  skipFiles: [
    "mocks/",
    "upgradeable/",
    "interfaces/",
  ],
};
