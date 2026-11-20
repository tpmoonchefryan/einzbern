# Devin host integration v1

This contract describes the candidate Devin (CLI and Devin Desktop) integration: hook registration, the read window, subagent profiles and dispatch records. It does not establish that a Devin session ran a candidate hook, or that a subagent used the model a profile names. Devin cloud sessions, a headless runner and plugin packaging are outside this contract.

## Surfaces, selection and configuration directory

Devin CLI and Devin Desktop share one user configuration directory: `${XDG_CONFIG_HOME:-$HOME/.config}/devin`, or `%APPDATA%\devin` on Windows. Einzbern follows `XDG_CONFIG_HOME` or `APPDATA` only when it names a directory inside the home being configured, so a run for another home is never redirected to the invoking user's configuration.

The existing configuration directory is the selection evidence. A project `.devin/` directory or an installed binary alone does not select Devin. `probeDevinHost` observes `devin --version` and, on macOS, the Desktop bundle; neither proves which surface a later session used. Doctor reports `selected`, `not-selected` or `selection-unknown`; when Devin is not selected its missing hooks and profiles are not failures.

## Hooks

Devin reads user-level hooks from the `hooks` key of `config.json` in that directory, in the grouped format Claude Code uses. Einzbern manages only its own commands there, through the same plan, merge, backup and rollback as the other grouped hook files. Every other key and every other hook stays as it is.

| Event | Behaviour |
| --- | --- |
| `UserPromptSubmit` | Recall for the submitted prompt, returned as `hookSpecificOutput.additionalContext`. |
| `PreToolUse`, matcher `^read$` | The read window below. The matcher keeps the hook from starting for other tools. |
| `SessionStart` | The navigation pointer, only when shared navigation was declined. |

Devin has no subagent-start event, and none is registered. A subagent starts with the always-on rules and its profile text.

Managed commands are identified by the Einzbern launcher command. Each one binds `EINZBERN_HOST` to `devin`. An edited managed group, such as a changed matcher, is a conflict: setup, update, repair and uninstall refuse it and keep the file. Devin accepts comments in `config.json`; a file that is not strict JSON cannot be written back without loss, so it is refused with `HOST_HOOKS_FILE_UNSUPPORTED` and left unchanged.

### The imported Claude Code registration

Devin also runs the hooks it imports from Claude Code's settings and gives them both `DEVIN_PROJECT_DIR` and `CLAUDE_PROJECT_DIR`. Without a rule, one prompt would be recalled twice and recorded as Claude Code.

| Run | Result |
| --- | --- |
| Devin's own command | Answers as host `devin`. |
| Imported command, Devin's own registration installed | Answers nothing. One `HOOK_DEVIN_IMPORT_YIELDED` line is logged per prompt. |
| Imported command, no registration of Devin's own | Answers as host `devin`. |

The launcher decides this before any engine version is loaded, from `DEVIN_PROJECT_DIR` and the commands in Devin's `config.json`. A run that carries `DEVIN_PROJECT_DIR` is never treated as Codex, so it writes no Codex coordination state. Under Claude Code and Codex neither variable rule applies and their behaviour is unchanged.

## Read window

Devin's file reader is `read`, with `file_path`, a one-based `offset` and `limit`. For a regular file larger than 32 KiB (`32768` bytes) the call needs a `limit` of at most 200 lines whose window is at most 32 KiB. A call outside that is answered with `{"decision":"block","reason":"…"}`. Image files are shown by the host rather than read as text and are not judged. Shell commands are never interpreted as reads. Unknown input, missing paths and filesystem errors do not block.

## Coordination and subagent profiles

Devin belongs to the single-conversation family: one main conversation dispatches background subagents with `run_subagent` and is notified by the host when each completes. It does not poll, and no second coordinating conversation is used.

`run_subagent` takes a profile, not a model. The built-in `subagent_general` runs on the main conversation's model and `subagent_explore` on the host's default subagent model. A write-capable subagent on another model needs a custom profile, so Einzbern renders one profile for each tier row of the device model policy's `devin` host:

- file: `agents/einzbern-<category>-<order>.md` in the configuration directory;
- frontmatter: `name`, `description` and `model` only. A profile has no effort field; a tier whose effort is not `default` is rendered with that stated in its description;
- body: the Skill entry, the report rule and a managed marker line whose digest covers the rest of the file.

The role comes from the task prompt and the work item, not from the profile. A tier row without a model gets no profile, and a device without a `devin` policy gets none; dispatch then uses the built-in profiles.

Setup, update and repair reconcile the profiles with the policy. An unmodified engine copy is updated or, when its tier row is gone, removed after a backup. A file whose marker no longer matches, or that carries no marker, is the user's: it is kept and reported (`DEVIN_PROFILE_USER_EDITED`). Changing the policy does not rewrite profiles by itself; until the next reconcile the affected profile is `stale`.

`execution-policy-resolve --host devin` returns the resolved tier row and `devinProfile: { name, status }`. Escalation moves tier row by tier row, so the name follows the row. `status` is `current`, `missing`, `stale`, `modified` or `not-selected`; only `current` is the profile the policy describes.

## Dispatch records

Native dispatch uses the general protocol in `specs/host-fallback-v1.md` with `hostKind: "devin"`, `invocationKind: "native-tool"` and `toolName: "run_subagent"`. Selection is `explicit` when a managed profile is dispatched and `host-managed` for the built-in profiles. `read_subagent` returns and completion notifications are retained under their own names. The host does not return the model a subagent used; that field stays `unknown`.

A background subagent can use only tools already approved in the session and cannot prompt. Approval and permission rules are the user's; Einzbern writes none.

## Evidence boundary

Repository tests exercise the plan, merge, launcher, read window and profiles with Devin-shaped input. A session probe on Devin 3000.14.30833 observed that completion notifications reach the main conversation without polling and resume it after its output ended, that hooks run inside subagents, and that `UserPromptSubmit` does not fire for a subagent's task. `devin doctor --json` loaded rendered profiles from an isolated configuration directory. Whether a session runs the candidate hooks, whether `DEVIN_PROJECT_DIR` is present for imported hooks, and a batch dispatched through managed profiles remain native acceptance items.

## Source contracts

- [Devin hooks](https://docs.devin.ai/cli/extensibility/hooks/overview) — events, grouped format, input and output, locations.
- [Devin lifecycle hooks](https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks) — per-event input and tool names.
- [Devin subagents](https://docs.devin.ai/cli/subagents) — profiles, models, background permissions and completion notification.
- [Devin configuration import](https://docs.devin.ai/cli/reference/configuration/read-config-from) — what is imported from other tools.
- [Devin configuration file](https://docs.devin.ai/cli/reference/configuration/config-file) — file locations and keys.
