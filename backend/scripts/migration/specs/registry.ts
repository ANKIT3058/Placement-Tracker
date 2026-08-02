import type { MigrationSpec } from "../types.js";
import { ownershipSpec } from "./ownership.spec.js";

// Spec registry.
//
// Adding verification for a future migration is one entry here plus one spec
// file. No stage, no check, and no CLI code changes.

const SPECS: MigrationSpec[] = [ownershipSpec];

export const loadSpec = async (id: string): Promise<MigrationSpec> => {
  const spec = SPECS.find((candidate) => candidate.id === id);

  if (!spec) {
    throw new Error(
      `Unknown spec "${id}". Available: ${SPECS.map((s) => s.id).join(", ")}`,
    );
  }

  return spec;
};

export const listSpecs = (): MigrationSpec[] => SPECS;
