# INIT-053 current Portal verification

This record covers the current Portal tree. Historical INC-153 and INC-155 evidence remains bound to its original commits and bytes; `verify:portal` replays those blocks in their historical source snapshots, then checks the current sources and five-locale proof below.

```verbatim:node scripts/verbatim-evidence-proof.mjs init053-current-portal-proof
{
  "schemaVersion": "tcrn.init053-current-portal-proof.v1",
  "historicalEvidence": [
    {
      "path": "docs/reports/init-028-design/evidence/INC-153-restore-and-docs.md",
      "commit": "390eb5a1578dcd1086bde6b7c717ab1553d054b9",
      "committedAt": "2026-09-12T09:46:08+08:00",
      "bytes": 2758,
      "sha256": "e05b14591927af0df67dacf3eaabf4f7c12b4892111e8d350bc69b393aafe139",
      "command": "node scripts/verbatim-evidence-proof.mjs inc153-host-role-scan",
      "outputBytes": 560,
      "outputSha256": "89f414561a0f1d2f13e0431252f9801fc628f677efdc49e5060c3495fc004c9f"
    },
    {
      "path": "docs/reports/init-028-design/evidence/INC-155-coverage-integrity.md",
      "commit": "4058d96e83c696c7faf319b1c1d94face4219554",
      "committedAt": "2026-09-24T09:51:27+08:00",
      "bytes": 12416,
      "sha256": "438921486a1154e958a5adefdda3f80c9a80a4bdfb1ec53c637d67f55e58d97a",
      "command": "node scripts/coverage-conservation-proof.mjs",
      "outputBytes": 2048,
      "outputSha256": "6d5b7fe9a7e8b44981e84ea2e544b7ed104697faf2a631bf62a6642933e168ec"
    },
    {
      "path": "docs/reports/init-029-component-loop/evidence/STORY-252-ds-css-snapshot.md",
      "commit": "f58a238b2df55bd9c55144ea718cf807dc1dc5f1",
      "committedAt": "2026-10-14T06:51:28+08:00",
      "bytes": 5188,
      "sha256": "677ccd503004af2fb26370e2f5317082b913f10f5799667d27c26f16309a27c0",
      "command": "node scripts/ds-component-css-proof.mjs",
      "outputBytes": 1167,
      "outputSha256": "34649dc46d51fee1367a96f20515f7d186cbac0391c8250cb48019abf477cca9"
    }
  ],
  "currentSources": [
    {
      "path": "portal/index.html",
      "bytes": 501536,
      "sha256": "7dfa981d7ee388bdeaeb6ec48952bebed1b884ee008273a6a89882576a3fd4fa"
    },
    {
      "path": "portal/locales.js",
      "bytes": 289479,
      "sha256": "bba42a1d628d07c866c701b10a7eee3016c7e73a6f021686b238b3cc54baa339"
    },
    {
      "path": "portal/portal.mjs",
      "bytes": 93015,
      "sha256": "6ffd387aaa797663cc43348c4fd018320ea9dc45ab0127cf99a1cf0502815c34"
    },
    {
      "path": "portal/scripts/i18n-proof.mjs",
      "bytes": 16967,
      "sha256": "3fbed5d5a041c72051f844406dff582aa53ac509d6f30f3f75f7305661578903"
    },
    {
      "path": "portal/scripts/proof.mjs",
      "bytes": 790,
      "sha256": "898da358d7bbc21912b28051ebf93544fd51bdca70f06466c499b943be3d5351"
    },
    {
      "path": "portal/tests/portal.test.mjs",
      "bytes": 40424,
      "sha256": "94927be497a479e3368694be29af2dc7bc04c478ef4263bac220f3ab11a50b3f"
    },
    {
      "path": "portal/tests/ui-presence.test.mjs",
      "bytes": 88607,
      "sha256": "e239f01ebccb62e8a46cea42920b55fc119c1e219fcf4df08acff3da2ee0cccf"
    },
    {
      "path": "portal/tests/ui-presence-support.mjs",
      "bytes": 52227,
      "sha256": "380ade7b16a4e29788a8bebc7c1e2f95102a9d287f00d3954f1de8a897aa56ee"
    },
    {
      "path": "portal/tests/portal-support.mjs",
      "bytes": 20991,
      "sha256": "3d5d6cb46536ebd82239bf1cf11ba8236745a78213e57d2f5899a62e8ff18c57"
    },
    {
      "path": "portal/tests/portal-work.test.mjs",
      "bytes": 29874,
      "sha256": "3325d18ac08202bfa79f81b3b9c312be9d08c964492351ba6d7342404d1ee907"
    },
    {
      "path": "portal/tests/portal-configuration.test.mjs",
      "bytes": 57653,
      "sha256": "a3622bc580e1dde84ae0884867ef4b55369e3dc23ca4af43b9b374eed8dc2ff9"
    },
    {
      "path": "portal/tests/portal-library.test.mjs",
      "bytes": 32036,
      "sha256": "fbdc7de507d2bcf8a2db75ec6601b8a79395cdc9d07accc479fcae4d94cb9d04"
    },
    {
      "path": "portal/tests/ui-work.test.mjs",
      "bytes": 60881,
      "sha256": "440c4e5be1d6d8ba3cc18029f11eec31eeebf9a8ce8522330141f9253b99b3af"
    },
    {
      "path": "portal/tests/ui-configuration.test.mjs",
      "bytes": 124662,
      "sha256": "61776f2f24b66afae072c7f5939463645a76fb9cb2f696637f43d21d828f65cc"
    },
    {
      "path": "portal/tests/ui-library.test.mjs",
      "bytes": 38451,
      "sha256": "c77da065d44a804203fef0ca8a345e97cf23c081ba61f6d90e9a901f7bee2eed"
    },
    {
      "path": "tests/helpers/register-portal-libraries.mjs",
      "bytes": 2243,
      "sha256": "9b04d75c13c86894003fc5261e925f66419c5f49cd653a806a00aa56acf4ddcf"
    },
    {
      "path": "scripts/portal-tests.mjs",
      "bytes": 2521,
      "sha256": "f79b1d22464c5e058114fe6cdda36d1b7a4163baffa8fda25d7bdf068ca276f7"
    },
    {
      "path": "scripts/lib/test-roster.mjs",
      "bytes": 941,
      "sha256": "d907c71a875121d21d6b9cbb3bb63d9039240f0186b851588392a5d1bdfbcdc8"
    },
    {
      "path": "scripts/lib/verification-evidence.mjs",
      "bytes": 1515,
      "sha256": "91a3b99f18e1546a76697613b6a622977ee5e81b853af1a7f330030b675e76b2"
    },
    {
      "path": "portal/tests/disposable-portal-fetch.test.mjs",
      "bytes": 3592,
      "sha256": "bd33b82655afc88abe8f3ad77b219cd03d1650a8ed4979da439cccd0dd4e1e80"
    },
    {
      "path": "portal/tests/helpers/disposable-portal-fetch.mjs",
      "bytes": 790,
      "sha256": "8fb381787cc63f2286b462330f86f9aa69bb721680c9651aec01a75619c7a82b"
    },
    {
      "path": "packages/core/src/doctor.ts",
      "bytes": 44062,
      "sha256": "65d580b2c57d8ef6d801b96e8e89fbbcd9f37a909c27c9cfbe7e6234b6ded7ce"
    },
    {
      "path": "tests/doctor.test.mjs",
      "bytes": 30688,
      "sha256": "ab106971783a104fd360e381e904cafc6147267c1748e1ddfb2e0693632f3f65"
    },
    {
      "path": "scripts/verify-portal.mjs",
      "bytes": 5144,
      "sha256": "6468d345bbf01b31efa6150d71aa1860a4711a183c7380b46845aeaadcc5dc50"
    },
    {
      "path": "scripts/verbatim-evidence-meta-proof.mjs",
      "bytes": 5368,
      "sha256": "83287b2f71d61b0c0a2046607488abd8aa9da0aa02e1bba2ce78a14137552741"
    },
    {
      "path": "scripts/verbatim-evidence-proof.mjs",
      "bytes": 28912,
      "sha256": "9a8374c5c815917a4c89812059f933dd6762e788064b99e5d82ee5c6ef61b767"
    }
  ],
  "hostRoleScan": {
    "scan": "rg --no-line-number 'claude-code|codex|reviewer|role ===|host ===|host \\?' portal/index.html | sed 's/^ *//' | sort -u",
    "exitCode": 0,
    "matchCount": 22,
    "matches": [
      "$(\"#design-authority\").hidden = state.settings?.chain?.role === \"coordination\" || state.settingGroup !== authorityGroup || designAuthorityState.status === \"unset\";",
      ": `<section class=\"tcrn-surface\" data-content-scope=\"custom-variables\"><div class=\"tcrn-surface__head\"><div class=\"tcrn-surface__head-content\"><h2>${esc(t(\"variables.title\"))}</h2><p class=\"tcrn-text\">${esc(t(\"variables.note\"))}</p><p class=\"tcrn-text\">${esc(t(\"variables.replaceNote\"))}</p>${independentConfigurationMetadata(\"variable\", { scope: state.settings?.chain?.role === \"coordination\" ? \"library\" : \"project\" })}</div></div><div class=\"tcrn-table-shell tcrn-variable-table\" role=\"table\" aria-label=\"${esc(t(\"variables.title\"))}\" data-variable-table=\"true\"><div class=\"tcrn-table-shell__head\" role=\"row\">${headers.map((label) => `<span role=\"columnheader\">${esc(label)}</span>`).join(\"\")}</div>${variableRow({ name: \"\", type: \"string\", value: \"\", description: \"\" }, true)}${rows}</div></section>${source?.withheld?.length ? `<p class=\"tcrn-text\">${esc(t(\"variables.withheld\", { count: source.withheld.length }))}</p>` : \"\"}`;",
      ": target?.chain?.role === \"coordination\" ? t(\"projects.coordination\") : t(\"projects.unnamed\");",
      "const catalog = state.modelPolicy?.selectedHost === host ? state.modelPolicy : null;",
      "const chainRoleLabel = (role) => role === \"coordination\" ? t(\"chainIdentity.roleCoordination\") : role === \"project\" ? t(\"chainIdentity.roleProject\") : t(\"chainIdentity.undeclared\");",
      "const collectionReadOnly = (key) => state.settings?.chain?.role === \"coordination\" && Array.isArray(state.settings?.settings) && currentSetting(key) === undefined;",
      "const declared = BOOT.library?.chain?.role === \"project\" ? BOOT.library.chain.coordinationLibraryId : null;",
      "const modelPolicyHostControl = (host, pending) => `<label class=\"tcrn-field\"><span class=\"tcrn-field__label\">${esc(t(\"modelPolicy.host\"))}</span><select class=\"tcrn-select\" data-engine-model-policy-host aria-label=\"${esc(t(\"modelPolicy.host\"))}\" ${pending ? \"disabled\" : \"\"}>${modelPolicyHosts().map((name) => `<option value=\"${esc(name)}\"${name === host ? \" selected\" : \"\"}>${esc(name)}</option>`).join(\"\")}</select></label>`;",
      "const modelPolicyPendingFor = (host) => state.modelPolicyReadPending === true && state.modelPolicyReadTarget?.host === host && modelPolicyReadCurrent(state.modelPolicyReadTarget);",
      "const readiness = state.modelPolicy?.selectedHost === host ? state.modelPolicy.peerReadiness : null;",
      "const registered = (BOOT.libraries || []).filter((library) => library.chain?.role === \"coordination\" && library.libraryId !== own).map((library) => library.libraryId);",
      "const rendersSystemVariables = (key) => String(key) === \"artifact.language\" || String(key).startsWith(\"design.\") || (state.settings?.chain?.role === \"coordination\"",
      "const state = { locale: storedLocale ?? (Object.keys(LOCALES).includes(BOOT.machineDefaults?.locale) ? BOOT.machineDefaults.locale : null) ?? BOOT.defaultLocale ?? \"en\", theme: document.documentElement.dataset.tcrnTheme, page: \"dashboard\", dashboardTab: \"overview\", settingGroup: \"general\", collections: { \"models.category\": { draft: null, dirty: false, findings: [], refusal: null }, \"models.tiers\": { draft: null, dirty: false, findings: [], refusal: null } }, collectionFocus: null, transientTargetTimer: null, settings: null, machineSettings: null, configBackups: null, modelPolicy: null, modelPolicyHost: \"codex\", modelPolicyDrafts: new Map(), modelPolicyWrites: new Map(), modelPolicyRead: 0, modelPolicyReadTarget: null, modelPolicyReadPending: false, modelPolicyLibraryId: BOOT.library?.libraryId ?? null, variables: null, vocabulary: null, status: null, work: null, workRead: { library: 0, readingFor: null, again: false }, knowledge: null, knowledgeQuery: \"\", knowledgeStatus: \"valid\", knowledgeBody: null, gates: [], gateResponse: null, lastGateRun: null, commands: [], selectedVocabulary: \"conferenceTypes\", receipt: null, operationDetailsOpen: false, agentsText: \"\", reconciliation: null, rules: null, pendingSection: \"\", searchIndex: [], searchResults: [], searchSelection: 0 };",
      "const template = state.modelPolicy?.selectedHost === host ? state.modelPolicy.onboarding : null;",
      "if (!state.chainDeclarePending) $(\"[data-chain-role]\", form).value = identity?.role === \"coordination\" ? \"coordination\" : \"project\";",
      "if (host === \"codex\") {",
      "if (role === \"coordination\") return own ? [own] : [];",
      "output.push(`<p class=\"tcrn-text\" data-codex-peer-readiness=\"${readiness?.ready === true ? \"ready\" : \"not-ready\"}\">${esc(readiness?.ready === true ? t(\"modelPolicy.peerReady\") : t(\"modelPolicy.peerNotReady\"))}</p>`);",
      "return [...new Set([\"codex\", \"claude-code\", \"dsh\", ...configured])].sort();",
      "select.disabled = role === \"coordination\" || choices.length === 0;",
      "select.hidden = state.settings?.chain?.role === \"coordination\";",
      "target: configurationTarget(state.settings?.chain?.role === \"coordination\" ? \"library\" : \"project\"),"
    ]
  },
  "i18n": {
    "sourceCommand": "node portal/scripts/i18n-proof.mjs",
    "ok": true,
    "reasonCode": "I18N_CONTRACT_SATISFIED",
    "legs": [
      {
        "leg": "contract-snapshot",
        "ok": true,
        "reasonCode": "I18N_CONTRACT_SNAPSHOT_READY",
        "source": "portal/locale-contract.mjs"
      },
      {
        "leg": "locale-set",
        "ok": true,
        "reasonCode": "LOCALE_SET_MATCHES_CONTRACT",
        "missingLocales": [],
        "extraLocales": []
      },
      {
        "leg": "key-coverage",
        "ok": true,
        "reasonCode": "EVERY_KEY_TRANSLATED",
        "keyCount": 689,
        "localeCount": 5,
        "expectedStrings": 3445,
        "gaps": []
      },
      {
        "leg": "translation-reality",
        "ok": true,
        "reasonCode": "TRANSLATIONS_DIFFER_FROM_ENGLISH",
        "addedKeyCount": 0,
        "gaps": []
      },
      {
        "leg": "translation-full-table",
        "ok": true,
        "reasonCode": "FULL_LOCALE_TABLE_TRANSLATED",
        "baselineEqualCount": {
          "zh-CN": 33,
          "ja": 21,
          "ko": 21,
          "fr": 21
        },
        "problems": []
      },
      {
        "leg": "key-reachability",
        "ok": true,
        "reasonCode": "EVERY_LOCALE_KEY_REACHABLE",
        "unreachable": []
      },
      {
        "leg": "placeholders",
        "ok": true,
        "reasonCode": "PLACEHOLDERS_CONSISTENT",
        "gaps": []
      },
      {
        "leg": "setting-descriptions",
        "ok": true,
        "reasonCode": "EVERY_SETTING_DESCRIBED"
      }
    ]
  }
}
```
