// Reuse focused real-Pi cases rather than duplicating the regression suite.
export const contracts = [
  { name: "Extension / provider", file: "compat/resources.test.ts", tests: ["compat extension entry loads and registers seven models"] },
  { name: "Generation", file: "test/blocker-integration.test.ts", tests: ["B2 real Pi ordinary three turns stay persistent"] },
  { name: "Session / lifecycle", file: "test/ownership-integration.test.ts", tests: ["real Pi persisted restart bootstraps without native resume", "real Pi reload loses ownership and bootstraps fresh"] },
  { name: "System / context", file: "test/context-integration.test.ts", tests: ["CP3 real initial and persisted restart bootstrap"] },
  { name: "Context edit", file: "test/blocker-integration.test.ts", tests: ["B2 real Pi boundary edit bootstraps changed projection", "B2 real Pi boundary delete bootstraps changed projection", "B2 real Pi boundary append user bootstraps changed projection"] },
  { name: "Compaction", file: "test/context-integration.test.ts", tests: ["CP3 real compaction lifecycle keeps projected content exactly once"] },
  { name: "Fork / tree", file: "test/context-integration.test.ts", tests: ["CP3 real fork older projection fidelity", "CP3 real tree backward sibling return projection fidelity"] },
  { name: "Skills", file: "compat/resources.test.ts", tests: ["compat discovered skill catalog reaches the real provider context"] },
  { name: "Working UI", file: "test/progress-integration.test.ts", tests: ["real AgentSession / ExtensionRunner / registered provider / TUI frames", "Pi 0.87.1 retains activity across loader recreation and restores its own default"] },
  { name: "Print / JSON / RPC", file: "test/progress-modes.test.ts", tests: ["real print mode has no AGY progress UI or output pollution", "real json mode has no AGY progress UI or output pollution", "real rpc mode has no AGY progress UI or output pollution"] },
  { name: "Retry boundary", file: "test/host-runtime.test.ts", tests: ["CP4 real Pi retry enabled: service unavailable", "CP4 real Pi length recovery cannot replay native work"] },
];
