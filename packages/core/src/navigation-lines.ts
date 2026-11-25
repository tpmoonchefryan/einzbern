// SPDX-License-Identifier: Apache-2.0
import { BRAND } from "./names.js";

/** The navigation shared by managed files and pointer hooks. */
export const NAVIGATION_LINES: readonly string[] = Object.freeze([
  `This project is managed by ${BRAND.engine.name}.`,
  `Load the ${BRAND.helper.name} skill before you start work.`,
  `Recall first: run ${BRAND.engine.name}'s recall for the task before you plan or change anything.`,
]);
