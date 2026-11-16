// SPDX-License-Identifier: Apache-2.0

export class WorkflowCliError extends Error {
  readonly reasonCode: string;
  // TCRN-CROSS-INC-378: string facts a caller needs beside the code, such as whether the
  // event was committed; the bin prints the keys it allows on stderr.
  readonly details: Readonly<Record<string, string>> | undefined;

  constructor(reasonCode: string, message: string, details?: Readonly<Record<string, string>>) {
    super(message);
    this.name = "WorkflowCliError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}

export interface CliIo {
  write(value: string): void;
}

export function fail(reasonCode: string, message: string): never {
  throw new WorkflowCliError(reasonCode, message);
}

export function parseArguments(arguments_: readonly string[], allowed: readonly string[]): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  let index = 0;
  while (index < arguments_.length) {
    const token = arguments_[index];
    let name: string;
    let value: string;
    if (token !== undefined && token.startsWith("--") && token.includes("=")) {
      // Attached form --flag=value: split on the FIRST "=" so the value may itself
      // contain "=" or legitimately begin with "--" (unrepresentable in two-token form).
      const equalsAt = token.indexOf("=");
      name = token.slice(2, equalsAt);
      value = token.slice(equalsAt + 1);
      index += 1;
    } else {
      const next = arguments_[index + 1];
      // Two-token form is unchanged: a value beginning with "--" is still rejected,
      // which doubles as missing-value (undefined next) detection.
      if (!token?.startsWith("--") || next === undefined || next.startsWith("--")) {
        fail("CLI_ARGUMENT_MALFORMED", String(token ?? "missing"));
      }
      name = token.slice(2);
      value = next;
      index += 2;
    }
    if (!allowed.includes(name)) {
      fail("CLI_ARGUMENT_UNKNOWN", name);
    }
    if (Object.hasOwn(values, name)) {
      fail("CLI_ARGUMENT_DUPLICATE", name);
    }
    values[name] = value;
  }
  return values;
}

export function required(values: Readonly<Record<string, string>>, names: readonly string[]): void {
  const missing = names.filter((name) => !values[name]);
  if (missing.length > 0) {
    fail("CLI_ARGUMENT_MISSING", missing.join(","));
  }
}

// CQ-05(c): the single arbiter for integer-valued flags. A syntactically malformed value
// fails at the CLI boundary with CLI_ARGUMENT_MALFORMED naming the offending flag, instead
// of reaching core as NaN and being reported under a semantic reason code. The minimum is
// optional; only non-integers and values below it are rejected here, and every other
// integer reaches core for its own judgement.
export function integerValue(values: Readonly<Record<string, string>>, name: string, minimum: number = Number.MIN_SAFE_INTEGER): number {
  const value = Number(values[name]);
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail("CLI_ARGUMENT_MALFORMED", name);
  }
  return value;
}

export function booleanValue(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  fail("CLI_ARGUMENT_MALFORMED", name);
}
