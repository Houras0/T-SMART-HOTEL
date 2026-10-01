const { spawn } = require("child_process");
const path = require("path");

const child = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
  cwd: path.resolve(__dirname),
  env: process.env,
  stdio: "inherit",
});

const forwardSignal = (signal) => {
  if (!child.killed) child.kill(signal);
};

process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : code ?? 1;
});