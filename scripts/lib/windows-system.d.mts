// SPDX-License-Identifier: Apache-2.0
export declare function replaceWindowsFile(from: string, to: string): void;
export declare function syncWindowsDirectory(path: string): void;
export declare function openPrivateWindowsFile(path: string): Promise<import("node:fs/promises").FileHandle>;
export declare function windowsJobState(name: string | undefined, pid?: number): "missing" | "empty" | "member" | "active" | null;
export declare function windowsJobProcesses(name: string): { Exists: boolean; Pids: number[] };
export declare function queryWindows(script: string, timeoutMs?: number): unknown;
export declare function createPrivateWindowsDirectory(path: string): boolean;
export declare function hasPrivateWindowsPermissions(path: string): boolean;
export declare function retireWindowsOutputSession(path: string, expectedOwner: Uint8Array, destination: string): boolean;
