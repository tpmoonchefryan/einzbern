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
      "bytes": 526435,
      "sha256": "92e3295a9db2b240ac5012ab91e0cad9ded744d646873be2dc4951a3a160c2c1"
    },
    {
      "path": "portal/locales.js",
      "bytes": 313600,
      "sha256": "c74536cf6bee034ed233ac80564450f3c0facd45a8e45b8854226664dc9ed3b5"
    },
    {
      "path": "portal/portal.mjs",
      "bytes": 97029,
      "sha256": "8a16f2d15e70b41448bb7eac87e7ad9643264d870bf7384daf7538f922fef9c3"
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
      "bytes": 40696,
      "sha256": "cb1127f8938d5463ba973bf22cca8beae618ee7829b2663a7cf734ee345a6b33"
    },
    {
      "path": "portal/tests/ui-presence.test.mjs",
      "bytes": 84723,
      "sha256": "a2d050c34ce2d34b20a4fa825c514adc2ba9b4d4f026a394bdfb2dd1df5dd684"
    },
    {
      "path": "portal/tests/ui-presence-support.mjs",
      "bytes": 52071,
      "sha256": "91e1ecbf2ec1ba306d705f17ba83094867248c97a7909f0fbe429fcbc49158f4"
    },
    {
      "path": "portal/tests/portal-support.mjs",
      "bytes": 20602,
      "sha256": "fc0bd7a09516db26920932a241c7ccdad6aeec3d38dfd8ff3980e3bc9e702897"
    },
    {
      "path": "portal/tests/portal-work.test.mjs",
      "bytes": 29874,
      "sha256": "3325d18ac08202bfa79f81b3b9c312be9d08c964492351ba6d7342404d1ee907"
    },
    {
      "path": "portal/tests/portal-configuration.test.mjs",
      "bytes": 58892,
      "sha256": "c76395fa7dc0a34b30cf2df753b753f63c7d0fb4d20bd52dee50d1e405cda5d1"
    },
    {
      "path": "portal/tests/portal-library.test.mjs",
      "bytes": 32036,
      "sha256": "fbdc7de507d2bcf8a2db75ec6601b8a79395cdc9d07accc479fcae4d94cb9d04"
    },
    {
      "path": "portal/tests/ui-work.test.mjs",
      "bytes": 70035,
      "sha256": "01cc8704107d2811dcc00d8ff7847502aa510aa872d2d8279ac5a39daed85090"
    },
    {
      "path": "portal/tests/ui-configuration.test.mjs",
      "bytes": 126301,
      "sha256": "46e9650e2c40c708b11e55a7bb2a1db17372c896a38507659778f15b1761888e"
    },
    {
      "path": "portal/tests/ui-library.test.mjs",
      "bytes": 38408,
      "sha256": "10669b2c6f4f24c06795b8b6a9ccf770fa3b0cdf02f88a98ac894d5aceceb176"
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
      "bytes": 50334,
      "sha256": "a52b55272a0cce9951a90813cd82ff0b222607076a9767a5d217f19671653dc7"
    },
    {
      "path": "tests/doctor.test.mjs",
      "bytes": 38883,
      "sha256": "e1d8fce673ae22e74fb67c868d5f860827e5507359e4a6b4eb41625d99f41a6c"
    },
    {
      "path": "scripts/verify-portal.mjs",
      "bytes": 5144,
      "sha256": "6468d345bbf01b31efa6150d71aa1860a4711a183c7380b46845aeaadcc5dc50"
    },
    {
      "path": "scripts/lib/windows-historical-coverage.mjs",
      "bytes": 1749,
      "sha256": "c08fe4531ca65324ff8d945038f2fb4e215006cc7d63fb49d755e53c1da10b6c"
    },
    {
      "path": "scripts/verbatim-evidence-meta-proof.mjs",
      "bytes": 5572,
      "sha256": "41ed592413e7f7c77adef496e436c86ab66f05b68ddaabcfbc14505fa10c7c7e"
    },
    {
      "path": "scripts/verbatim-evidence-proof.mjs",
      "bytes": 29018,
      "sha256": "b0aa4f0e24ecfcd29012a83adc4b90331f34bb15f0810c70031ea80458a2efd3"
    }
  ],
  "hostRoleScan": {
    "scan": "rg --no-line-number 'claude-code|codex|reviewer|role ===|host ===|host \\?' portal/index.html | sed 's/^ *//' | sort -u",
    "exitCode": 0,
    "matchCount": 21,
    "matches": [
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
      "const state = { locale: storedLocale ?? (Object.keys(LOCALES).includes(BOOT.machineDefaults?.locale) ? BOOT.machineDefaults.locale : null) ?? BOOT.defaultLocale ?? \"en\", theme: document.documentElement.dataset.tcrnTheme, page: \"dashboard\", dashboardTab: \"overview\", settingGroup: \"general\", collections: { \"models.category\": { draft: null, dirty: false, findings: [], refusal: null }, \"models.tiers\": { draft: null, dirty: false, findings: [], refusal: null } }, collectionFocus: null, transientTargetTimer: null, settings: null, machineSettings: null, configBackups: null, modelPolicy: null, modelPolicyHost: \"codex\", modelPolicyDrafts: new Map(), modelPolicyWrites: new Map(), modelPolicyRead: 0, modelPolicyReadTarget: null, modelPolicyReadPending: false, modelPolicyLibraryId: BOOT.library?.libraryId ?? null, variables: null, vocabulary: null, status: null, work: null, workRead: { library: 0, readingFor: null, again: false }, knowledge: null, knowledgeQuery: \"\", knowledgeStatus: \"valid\", knowledgeBody: null, gates: [], gateResponse: null, lastGateRun: null, commands: [], selectedVocabulary: \"conferenceTypes\", receipt: null, operationDetailsOpen: false, agentsText: \"\", reconciliation: null, rules: null, pendingSection: \"\", searchIndex: [], searchResults: [], searchSelection: 0 };",
      "const template = state.modelPolicy?.selectedHost === host ? state.modelPolicy.onboarding : null;",
      "host.hidden = !designAuthorityUrl() || state.settings?.chain?.role === \"coordination\" || state.settingGroup !== settingGroup(\"design.authority\");",
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
        "keyCount": 744,
        "localeCount": 5,
        "expectedStrings": 3720,
        "gaps": []
      },
      {
        "leg": "translation-reality",
        "ok": true,
        "reasonCode": "TRANSLATIONS_DIFFER_FROM_ENGLISH",
        "addedKeyCount": 12,
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
