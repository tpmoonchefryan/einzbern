// SPDX-License-Identifier: Apache-2.0
import fs from "node:fs/promises";
import { listKnowledgeMetadata } from "../../dist/build/packages/core/src/knowledge-core.js";
import { listKnowledgeMetadataFast } from "../../dist/build/packages/core/src/knowledge-read.js";
import { readRecallCards } from "../../dist/build/packages/core/src/recall-inputs.js";
import { readRecallAuthority } from "../../dist/build/packages/core/src/recall-authority.js";
import { withRecallObservation } from "../../dist/build/packages/core/src/recall-observation.js";

const [mode, root, text] = process.argv.slice(2), query = JSON.parse(text);
const started = Date.now();
let replacementTriggered = false;
try {
  const result = await withRecallObservation(async () => {
    if (mode === "full") return listKnowledgeMetadata(root, { ...query, beforeDescriptorReadForTest() {} });
    if (mode === "list") return listKnowledgeMetadata(root, query);
    if (mode === "replacement") {
      const { replacementPath, backupPath, ...listQuery } = query;
      try {
        return await listKnowledgeMetadata(root, { ...listQuery, afterDescriptorOpenForTest: async path => {
          if (path !== replacementPath || replacementTriggered) return;
          replacementTriggered = true;
          const originalBytes = await fs.readFile(path);
          await fs.rename(path, backupPath);
          await fs.writeFile(path, originalBytes);
        } });
      } finally {
        if (replacementTriggered) {
          await fs.rm(replacementPath, { force: true });
          await fs.rename(backupPath, replacementPath);
        }
      }
    }
    const { authority } = await readRecallAuthority(root);
    if (mode === "fast") return listKnowledgeMetadataFast(root, query, authority);
    if (mode === "recall") return readRecallCards(root, query, authority);
    throw new Error("unknown fixture entry");
  });
  console.log(JSON.stringify({ pid: process.pid, started, ended: Date.now(), ...result }));
} catch (error) {
  console.log(JSON.stringify({ pid: process.pid, started, ended: Date.now(), error: error.reasonCode ?? error.message, replacementTriggered }));
}
