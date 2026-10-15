# Contract: Path Matching and Normalisation

New in revision 2. Resolves the glob dialect before Gate B (FR-093, FR-094). Used for `allowedPaths`, `protectedPaths`,
`sensitivePaths`, `ignoredExclusions`, the mandatory protected set, and diff inspection. The dialect is a **small, closed subset**
implemented by the engine itself (no runtime dependency may be added); anything outside it is rejected, never guessed.

## 1. Platform

POSIX only (macOS, Linux). On `win32` the Harness refuses to start (`HARNESS_PLATFORM_UNSUPPORTED`). The separator is `/`.
Matching is **case-sensitive**. Case-insensitive filesystems (default macOS) are handled by collision detection (§4), not by case-folding.

## 2. Candidate paths (what is matched)

A candidate is a workspace-relative path as reported by git (`-z`, NUL-delimited, never parsed from human-readable output).
Before matching it is **validated**, not silently normalised. A candidate is `INVALID_PATH` (⇒ treated as out of scope, fail closed) if it:
- is empty, absolute (starts with `/`), or contains a drive prefix;
- has an empty segment (`a//b`), a `.` segment, a `..` segment, or a trailing `/` (directories are never candidates, only files and symlinks);
- contains NUL or any control character (< 0x20, 0x7F);
- contains a backslash `\` (valid on POSIX but ambiguous; refused);
- is not valid UTF-8.
Unicode: candidates and patterns are compared after **NFC normalisation** of both; two distinct byte paths that collide after NFC or after
case-folding within one snapshot are `PATH_AMBIGUOUS` (suspension; the Harness does not choose).

## 3. Pattern dialect

A pattern is a `/`-separated list of segments, anchored at the workspace root (**always anchored**; there is no gitignore-style floating).

| Element | Meaning |
|---|---|
| literal characters | match themselves |
| `*` | zero or more characters within one segment; **never** matches `/`; **does** match a leading `.` |
| `?` | exactly one character within one segment, never `/` |
| `**` | only as a **whole segment**: matches zero or more whole directory segments |
| trailing `/**` | everything beneath the directory at any depth; does **not** match the directory path itself (candidates are files anyway) |
| trailing `/` | sugar for `/**` |

Rejected at policy/envelope validation (`INVALID_PATTERN`): empty pattern; leading `/`; any `..` or `.` segment; backslash; `[`…`]`
character classes; `{`…`}` braces; `!` negation; `**` mixed with other characters in a segment (`a**b`, `**x`); `***`; NUL/control characters; non-UTF-8;
more than 256 segments or 4096 bytes. There is no escaping: file names that contain `*` or `?` literally cannot be targeted by a pattern except through `**`.

Matching is a **full match** of the whole candidate: `*` and `?` do not cross `/`, and a pattern without `/` matches only a top-level file.

## 4. Scope decision

A candidate path `p` is **in scope** iff all hold:
1. `p` is valid (§2) and not `PATH_AMBIGUOUS`;
2. `p` matches ≥ 1 `allowedPaths` pattern;
3. `p` matches **no** pattern in `protectedPaths ∪ mandatory protected set` (deny wins over allow, always);
4. the symlink rules (§5) pass.
`sensitivePaths` is orthogonal: a match adds review obligations (FR-031); it does not by itself deny. `ignoredExclusions` is used only by the snapshot (FR-084).

## 5. Symlinks

- Matching uses the **lexical** path as listed by git **and** the resolved path: every parent directory component is checked with `lstat`; if **any parent component is a symlink**, the candidate is `INVALID_PATH` (a change "through" a symlinked directory is out of scope).
- Any **added or modified symlink entry** (mode `120000`) is out of scope in the MVP (`SYMLINK_CHANGE`), regardless of patterns, because its target can redirect later reads/writes.
- A pre-existing symlink that is not modified is recorded in the snapshot as `OPAQUE` (path, target string, mode) and its target is never followed by the snapshot provider.
- Validator `cwd` (verification-pipeline §3) uses `realpath` and must remain inside the workspace root (`CWD_ESCAPE` otherwise).
- Hard links and bind mounts are not detected (documented limitation, E3).

## 6. Normalisation of patterns

At validation the pattern is checked, never rewritten, except: repeated `/` is rejected (not collapsed); a trailing `/` is expanded to `/**` and stored in the expanded form so the digest is canonical.

## 7. Test vectors (normative; SC-009)

`allowed` = the pattern under test, with no protected patterns, unless the row says otherwise. ✔ = in scope.

| # | Pattern | Candidate | Result | Rule |
|---|---|---|---|---|
| 1 | `src/*.ts` | `src/a.ts` | ✔ | `*` within segment |
| 2 | `src/*.ts` | `src/a/b.ts` | ✘ | `*` never crosses `/` |
| 3 | `src/*.ts` | `src/.ts` | ✔ | `*` may be empty and matches leading dot |
| 4 | `src/*` | `src/.hidden` | ✔ | leading dot matched |
| 5 | `src/**` | `src/a/b/c.ts` | ✔ | any depth |
| 6 | `src/**` | `src2/x.ts` | ✘ | segment boundary |
| 7 | `src/**` | `src` (as file) | ✘ | `/**` excludes the dir path itself |
| 8 | `**/x.ts` | `x.ts` | ✔ | zero directories |
| 9 | `**/x.ts` | `a/b/x.ts` | ✔ | many directories |
| 10 | `a/**/b.ts` | `a/b.ts` | ✔ | zero middle dirs |
| 11 | `a/**/b.ts` | `a/x/y/b.ts` | ✔ | |
| 12 | `a/?.ts` | `a/ab.ts` | ✘ | `?` is exactly one char |
| 13 | `README.md` | `docs/README.md` | ✘ | always anchored at root |
| 14 | `src/` | `src/a.ts` | ✔ | trailing `/` ⇒ `src/**` |
| 15 | `src/**` | `src/../.git/config` | ✘ | `..` ⇒ `INVALID_PATH` |
| 16 | `**` | `/etc/passwd` | ✘ | absolute ⇒ `INVALID_PATH` |
| 17 | `src/**` | `src\\a.ts` (literal backslash) | ✘ | backslash ⇒ `INVALID_PATH` |
| 18 | `src/**` | `src/a//b.ts` | ✘ | empty segment |
| 19 | `src/**` + protected `src/gen/**` | `src/gen/x.ts` | ✘ | deny wins |
| 20 | `**` | `.project-run/runs/x.json` | ✘ | mandatory protected set |
| 21 | `**` | `.git/hooks/pre-commit` | ✘ | mandatory protected set |
| 22 | `src/**` | `src/link/x.ts` where `src/link` is a symlink dir | ✘ | parent component symlink |
| 23 | `src/**` | `src/new-link` mode `120000` added | ✘ | symlink change |
| 24 | `src/**` | `src/é.ts` (NFD bytes) vs pattern `src/é.ts` (NFC) | ✔ | NFC comparison |
| 25 | `src/a.ts` | `src/A.ts` | ✘ | case-sensitive |
| 26 | snapshot containing `src/a.ts` and `src/A.ts` | — | `PATH_AMBIGUOUS` | case-fold collision |
| 27 | pattern `src/[ab].ts` | — | `INVALID_PATTERN` | classes unsupported |
| 28 | pattern `/src/**` | — | `INVALID_PATTERN` | leading `/` |
| 29 | pattern `src/a**b` | — | `INVALID_PATTERN` | `**` not a whole segment |
| 30 | pattern `src/../x` | — | `INVALID_PATTERN` | `..` segment |
| 31 | `**` | `.agents/skills/speckit-implement/SKILL.md` | ✘ | mandatory protected set (OD-18, approved) |
| 32 | `**` | `.project-run/skills/custom/SKILL.md` | ✘ | mandatory protected set (OD-18, approved) |

## 8. Implementation constraints

Pure function `(pattern, candidate) → boolean` with no filesystem access; the symlink/`lstat` checks are a separate step. Matcher is
linear in pattern + path length (no backtracking regular expressions built from user text, to avoid ReDoS). All vectors above run as table tests.
