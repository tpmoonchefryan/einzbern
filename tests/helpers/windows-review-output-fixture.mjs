// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { collectReviewEvidence, REVIEW_OUTPUT_BYTES } from "../../scripts/review-evidence.mjs";

const base = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const testFile = "tests/review-evidence.test.mjs";

for (const size of [128, 2 * 1024 * 1024, REVIEW_OUTPUT_BYTES + 1]) {
  test(`review output retains the count and SHA-256 for ${size} bytes`, () => {
    const run = collectReviewEvidence({
      repositoryRoot: process.cwd(),
      base,
      allowedFiles: [testFile],
      testFiles: [testFile],
      testCommand: `node -e "process.stdout.write(Buffer.alloc(${size},65))"`,
    }).evidence.testRun.result;

    const expectedComplete = size <= REVIEW_OUTPUT_BYTES;
    const observed = {
      exitCode: run.exitCode,
      stdoutBytes: run.stdoutBytes,
      stdoutSha256: run.stdoutSha256,
      outputComplete: run.outputComplete,
    };
    console.log(JSON.stringify({ platform: process.platform, requestedBytes: size, ...observed }));
    assert.deepEqual(observed, {
      exitCode: expectedComplete ? "0" : "OUTPUT_LIMIT",
      stdoutBytes: size,
      stdoutSha256: createHash("sha256").update(Buffer.alloc(size, 65)).digest("hex"),
      outputComplete: expectedComplete,
    });
  });
}
