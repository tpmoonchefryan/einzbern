// SPDX-License-Identifier: Apache-2.0
import { BRAND } from "./names.js";

/** One Skill entry shared by managed navigation and fallback pointer hooks. */
export const NAVIGATION_LINES: readonly string[] = Object.freeze([
  `This workspace uses ${BRAND.engine.name}. Load and follow the ${BRAND.helper.name} skill for applicable work.`,
]);
