module.exports = {
  // configureYulOptimizer enables stackAllocation in the Yul optimizer,
  // which helps avoid "Stack too deep" errors from coverage instrumentation.
  configureYulOptimizer: true,
  skipFiles: [
    "mocks/",
  ],
};
