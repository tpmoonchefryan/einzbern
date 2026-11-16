#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { runSourceAttestor } from "../dist/build/packages/core/src/source-attestor-service.js";
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 65536) throw new Error("attestor-launch-capacity");
}
try { await runSourceAttestor(JSON.parse(input)); }
catch (error) { console.error(String(error.message)); process.exitCode = 1; }
