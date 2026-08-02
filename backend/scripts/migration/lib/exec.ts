import { spawn } from "node:child_process";
import { createWriteStream, createReadStream } from "node:fs";

export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export class CommandFailure extends Error {
  constructor(
    readonly command: string,
    readonly result: RunResult,
  ) {
    super(
      `${command} exited with code ${result.code}\n${result.stderr.trim() || result.stdout.trim()}`,
    );
    this.name = "CommandFailure";
  }
}

/**
 * Run a command and capture its output.
 *
 * `env` is merged over `process.env` rather than replacing it, so PGPASSWORD can
 * be supplied without losing PATH.
 */
export const run = async (
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...options.env },
      // No shell: arguments are passed as an array, so a database name or
      // password containing shell metacharacters cannot be reinterpreted.
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    child.on("error", (error) => reject(error));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
};

export const runOrThrow = async (
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> => {
  const result = await run(command, args, options);

  if (result.code !== 0) {
    throw new CommandFailure([command, ...args].join(" "), result);
  }

  return result;
};

/**
 * Run a command and stream its stdout to a file. Used for dumps, whose output
 * is binary and can be large enough that buffering it in memory is wasteful.
 */
export const runToFile = async (
  command: string,
  args: string[],
  filePath: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...options.env },
      shell: false,
    });

    const out = createWriteStream(filePath);
    let stderr = "";

    child.stdout.pipe(out);
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    child.on("error", reject);
    child.on("close", (code) => {
      out.end();

      if (code !== 0) {
        return reject(
          new CommandFailure([command, ...args].join(" "), {
            code: code ?? -1,
            stdout: "",
            stderr,
          }),
        );
      }

      out.on("finish", resolve);
    });
  });
};

/** Run a command with a file streamed into its stdin. Used for restores. */
export const runFromFile = async (
  command: string,
  args: string[],
  filePath: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...options.env },
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    createReadStream(filePath).pipe(child.stdin);

    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code: code ?? -1, stdout, stderr }),
    );
  });
};
