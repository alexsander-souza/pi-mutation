import type { RunnerEntry, TestRunner } from "../types";
import { pythonRunner } from "./python";
import { goRunner } from "./go";

const registry: Record<string, TestRunner> = {};

export function registerRunner(entry: RunnerEntry): void {
  registry[entry.language] = entry.runner;
}

export function getRunner(language: string): TestRunner | undefined {
  return registry[language];
}

registerRunner({ language: "python", extensions: [".py"], runner: pythonRunner });
registerRunner({ language: "go", extensions: [".go"], runner: goRunner });
