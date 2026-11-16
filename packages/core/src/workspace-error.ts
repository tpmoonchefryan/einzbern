// SPDX-License-Identifier: Apache-2.0
import type { WorkspaceReasonCode } from "./workspace.js";

export class WorkspaceError extends Error {
  readonly reasonCode: WorkspaceReasonCode;
  readonly details: Readonly<Record<string, string>> | undefined;

  constructor(reasonCode: WorkspaceReasonCode, message: string, details?: Readonly<Record<string, string>>) {
    super(message);
    this.name = "WorkspaceError";
    this.reasonCode = reasonCode;
    this.details = details;
  }
}
