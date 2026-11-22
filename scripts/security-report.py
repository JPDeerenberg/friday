#!/usr/bin/env python3
"""Regenerate dependabot-alerts.md with every GitHub security report for the repo.

Covers:
  * Dependabot alerts (open, fixed, dismissed)
  * Code scanning alerts (CodeQL)
  * Secret scanning alerts (skipped when the feature is disabled)
  * Repository security advisories

Usage:
    python3 scripts/security-report.py [--repo OWNER/NAME] [--out FILE]

Requires an authenticated `gh` CLI (`gh auth status`). Read-only: every call is a
GET against the GitHub REST API, nothing is written to GitHub.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

SEVERITY_ORDER = ["critical", "high", "medium", "low", "warning", "note", "error", "unknown"]


def gh_api(path: str) -> list | dict | None:
    """GET a paginated REST endpoint. Returns None when the feature is unavailable."""
    cmd = ["gh", "api", f"repos/{path}", "--paginate"]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        msg = (proc.stderr or "").strip().splitlines()
        reason = msg[0] if msg else "unknown error"
        if "disabled" in reason.lower() or "404" in reason:
            return None
        sys.exit(f"gh api {path} failed: {reason}")
    out = proc.stdout.strip()
    if not out:
        return []
    # --paginate concatenates JSON arrays; split them back together.
    decoder = json.JSONDecoder()
    items: list = []
    idx = 0
    while idx < len(out):
        obj, end = decoder.raw_decode(out, idx)
        items.extend(obj if isinstance(obj, list) else [obj])
        idx = end
        while idx < len(out) and out[idx].isspace():
            idx += 1
    return items


def sev_rank(sev: str | None) -> int:
    sev = (sev or "unknown").lower()
    return SEVERITY_ORDER.index(sev) if sev in SEVERITY_ORDER else len(SEVERITY_ORDER)


def cell(text: object) -> str:
    return str(text if text not in (None, "", []) else "-").replace("|", "\\|").replace("\n", " ")


def shorten(text: str | None, limit: int = 420) -> str:
    """Flatten rule help text: drop markdown headings, cut on a word boundary."""
    if not text:
        return ""
    kept = [ln for ln in text.splitlines() if not ln.lstrip().startswith("#")]
    flat = " ".join(" ".join(kept).split())
    if len(flat) <= limit:
        return flat
    cut = flat[:limit].rsplit(" ", 1)[0].rstrip(",;:")
    return f"{cut} …"


# ---------------------------------------------------------------- dependabot ---


def render_dependabot(alerts: list[dict]) -> list[str]:
    open_alerts = [a for a in alerts if a["state"] == "open"]
    fixed = [a for a in alerts if a["state"] == "fixed"]
    other = [a for a in alerts if a["state"] not in ("open", "fixed")]
    lines: list[str] = []

    lines.append("## Dependabot alerts")
    lines.append("")
    lines.append(f"**Total: {len(alerts)}** — {len(open_alerts)} open, {len(fixed)} fixed, {len(other)} dismissed")
    lines.append("")

    if open_alerts:
        by_sev: Counter[str] = Counter(a["security_advisory"]["severity"].lower() for a in open_alerts)
        by_eco: Counter[str] = Counter(a["dependency"]["package"]["ecosystem"] for a in open_alerts)
        summary = " · ".join(f"{sev} {by_sev[sev]}" for sev in SEVERITY_ORDER if by_sev[sev])
        lines.append(f"Open by severity: {summary}")
        lines.append("")
        lines.append("Open by ecosystem: " + " · ".join(f"{eco} {n}" for eco, n in by_eco.most_common()))
        lines.append("")

        # Affected package + worst severity, so the fix list is short and actionable.
        grouped: dict[tuple[str, str], list[dict]] = defaultdict(list)
        for a in open_alerts:
            pkg = a["dependency"]["package"]
            grouped[(pkg["ecosystem"], pkg["name"])].append(a)
        lines.append("### Open alerts — affected packages")
        lines.append("")
        lines.append("| Package | Ecosystem | Alerts | Worst severity | Installed | Upgrade to | Manifests |")
        lines.append("|---|---|---|---|---|---|---|")
        rows = []
        for (eco, name), group in grouped.items():
            worst = min((a["security_advisory"]["severity"].lower() for a in group), key=sev_rank)
            installed = sorted({a["dependency"].get("version_requirement") or "-" for a in group})
            patched = sorted(
                {
                    ((a.get("security_vulnerability") or {}).get("first_patched_version") or {}).get(
                        "identifier"
                    )
                    or "no fix"
                    for a in group
                }
            )
            manifests = sorted({a["dependency"]["manifest_path"] for a in group})
            rows.append(
                (
                    sev_rank(worst),
                    name,
                    f"| {cell(name)} | {cell(eco)} | {len(group)} | {cell(worst)} | "
                    f"{cell(', '.join(installed))} | {cell(', '.join(patched))} | "
                    f"{cell(', '.join(f'`{m}`' for m in manifests))} |",
                )
            )
        for _, _, row in sorted(rows, key=lambda r: (r[0], r[1])):
            lines.append(row)
        lines.append("")

        lines.append(f"### Open alerts ({len(open_alerts)})")
        lines.append("")
        for a in sorted(
            open_alerts,
            key=lambda a: (sev_rank(a["security_advisory"]["severity"]), -a["number"]),
        ):
            adv = a["security_advisory"]
            dep = a["dependency"]
            pkg = dep["package"]
            sv = a.get("security_vulnerability") or {}
            vrange = sv.get("vulnerable_version_range") or "-"
            patched = (sv.get("first_patched_version") or {}).get("identifier") or "no fix"
            lines.append(f"#### #{a['number']} — {pkg['name']} — {adv['severity'].upper()}")
            lines.append("")
            lines.append(f"- **Advisory:** {adv['summary']}")
            lines.append(f"- **GHSA:** {adv['ghsa_id']} | **CVE:** {adv.get('cve_id') or '-'}")
            scope = dep.get("scope") or "unknown"
            relationship = dep.get("relationship") or "unknown"
            lines.append(f"- **Ecosystem / scope:** {pkg['ecosystem']} / {scope} ({relationship})")
            lines.append(f"- **Manifest:** `{dep['manifest_path']}` — installed: `{dep.get('version_requirement') or '-'}`")
            lines.append(f"- **Vulnerable range:** `{vrange}` → **first patched version:** `{patched}`")
            lines.append(f"- **Alert URL:** {a['html_url']}")
            lines.append(f"- **Created:** {a['created_at']}")
            lines.append("")
    else:
        lines.append("No open Dependabot alerts.")
        lines.append("")

    if other:
        lines.append(f"### Dismissed alerts ({len(other)})")
        lines.append("")
        lines.append("| # | Package | Ecosystem | Severity | State | Auto-dismissed at | Comment | GHSA |")
        lines.append("|---|---|---|---|---|---|---|---|")
        for a in sorted(other, key=lambda a: -a["number"]):
            adv = a["security_advisory"]
            pkg = a["dependency"]["package"]
            reason = a.get("dismissed_reason") or ("auto-dismissed" if a.get("auto_dismissed_at") else "-")
            comment = a.get("dismissed_comment") or "-"
            lines.append(
                f"| #{a['number']} | {cell(pkg['name'])} | {cell(pkg['ecosystem'])} | {cell(adv['severity'])} | "
                f"{cell(reason)} | {cell(a.get('auto_dismissed_at') or a.get('dismissed_at'))} | "
                f"{cell(comment)} | {cell(adv['ghsa_id'])} |"
            )
        lines.append("")

    if fixed:
        lines.append(f"### Fixed alerts ({len(fixed)})")
        lines.append("")
        lines.append("| # | Package | Ecosystem | Severity | Manifest | GHSA | CVE | Advisory |")
        lines.append("|---|---|---|---|---|---|---|---|")
        for a in sorted(
            fixed, key=lambda a: (sev_rank(a["security_advisory"]["severity"]), -a["number"])
        ):
            adv = a["security_advisory"]
            pkg = a["dependency"]["package"]
            lines.append(
                f"| #{a['number']} | {cell(pkg['name'])} | {cell(pkg['ecosystem'])} | {cell(adv['severity'])} | "
                f"`{cell(a['dependency']['manifest_path'])}` | {cell(adv['ghsa_id'])} | {cell(adv.get('cve_id'))} | "
                f"{cell(adv['summary'])} |"
            )
        lines.append("")

    return lines


# ------------------------------------------------------------ code scanning ---


def render_code_scanning(alerts: list[dict] | None) -> list[str]:
    lines = ["## Code scanning alerts (CodeQL)", ""]
    if alerts is None:
        return lines + ["Code scanning is not enabled on this repository.", ""]
    if not alerts:
        return lines + ["No code scanning alerts.", ""]

    open_alerts = [a for a in alerts if a["state"] == "open"]
    fixed = [a for a in alerts if a["state"] == "fixed"]
    by_rule: Counter[str] = Counter(a["rule"]["id"] for a in open_alerts)
    by_sev: Counter[str] = Counter(
        (a["rule"].get("security_severity_level") or a["rule"].get("severity") or "unknown").lower()
        for a in open_alerts
    )
    tools = sorted({a["tool"]["name"] for a in alerts})

    lines.append(f"**Total: {len(alerts)}** — {len(open_alerts)} open, {len(fixed)} fixed")
    lines.append("")
    lines.append(f"Tool(s): {', '.join(tools)}")
    lines.append("")
    if open_alerts:
        summary = " · ".join(f"{s} {by_sev[s]}" for s in SEVERITY_ORDER if by_sev[s])
        lines.append(f"Open by security severity: {summary}")
        lines.append("")
        lines.append("### Open alerts by rule")
        lines.append("")
        lines.append("| Rule | Alerts | Files |")
        lines.append("|---|---|---|")
        for rule_id, count in by_rule.most_common():
            files = sorted(
                {
                    a["most_recent_instance"]["location"]["path"]
                    for a in open_alerts
                    if a["rule"]["id"] == rule_id
                }
            )
            lines.append(f"| `{cell(rule_id)}` | {count} | {cell(', '.join(files))} |")
        lines.append("")

        lines.append(f"### Open alerts ({len(open_alerts)})")
        lines.append("")
        # Group by rule: CodeQL fires the same query many times per file, so one
        # section per rule with a location table stays readable.
        by_rule_alerts: dict[str, list[dict]] = defaultdict(list)
        for a in open_alerts:
            by_rule_alerts[a["rule"]["id"]].append(a)
        for rule_id, group in sorted(
            by_rule_alerts.items(),
            key=lambda kv: (
                sev_rank(kv[1][0]["rule"].get("security_severity_level") or kv[1][0]["rule"].get("severity")),
                kv[0],
            ),
        ):
            rule = group[0]["rule"]
            sev = (rule.get("security_severity_level") or rule.get("severity") or "unknown").upper()
            lines.append(f"#### `{rule_id}` — {sev} — {len(group)} alert(s)")
            lines.append("")
            lines.append(f"- **Description:** {rule.get('description') or rule.get('name')}")
            if rule.get("full_description"):
                lines.append(f"- **Details:** {shorten(rule['full_description'], 300)}")
            if rule.get("help"):
                lines.append(f"- **Guidance:** {shorten(rule['help'])}")
            if rule.get("help_uri"):
                lines.append(f"- **Docs:** {rule['help_uri']}")
            lines.append("")
            lines.append("| # | Location | Created | Alert URL |")
            lines.append("|---|---|---|---|")
            for a in sorted(
                group,
                key=lambda a: (
                    a["most_recent_instance"]["location"]["path"],
                    a["most_recent_instance"]["location"].get("start_line") or 0,
                ),
            ):
                loc = a["most_recent_instance"]["location"]
                lines.append(
                    f"| #{a['number']} | `{cell(loc['path'])}` line {cell(loc.get('start_line'))} | "
                    f"{cell(a['created_at'][:10])} | {a['html_url']} |"
                )
            lines.append("")
    else:
        lines.append("No open code scanning alerts.")
        lines.append("")

    if fixed:
        lines.append(f"### Fixed alerts ({len(fixed)})")
        lines.append("")
        lines.append("| # | Rule | Severity | Location | Fixed at | Advisory |")
        lines.append("|---|---|---|---|---|---|")
        for a in sorted(fixed, key=lambda a: -a["number"]):
            rule = a["rule"]
            loc = a["most_recent_instance"]["location"]
            sev = (rule.get("security_severity_level") or rule.get("severity") or "unknown").lower()
            lines.append(
                f"| #{a['number']} | `{cell(rule['id'])}` | {cell(sev)} | `{cell(loc['path'])}` line "
                f"{cell(loc.get('start_line'))} | {cell(a.get('fixed_at'))} | {cell(rule.get('description'))} |"
            )
        lines.append("")

    return lines


# --------------------------------------------------------------------- main ---


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default="JPDeerenberg/friday")
    parser.add_argument("--out", default="dependabot-alerts.md")
    args = parser.parse_args()

    dependabot = gh_api(f"{args.repo}/dependabot/alerts")
    codescan = gh_api(f"{args.repo}/code-scanning/alerts")
    secretscan = gh_api(f"{args.repo}/secret-scanning/alerts")
    advisories = gh_api(f"{args.repo}/security-advisories")
    dependabot = dependabot if isinstance(dependabot, list) else []
    codescan = codescan if isinstance(codescan, list) else None
    advisories = advisories if isinstance(advisories, list) else []

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    owner, name = args.repo.split("/")
    open_dep = sum(1 for a in dependabot if a["state"] == "open")
    open_scan = sum(1 for a in (codescan or []) if a["state"] == "open")

    lines: list[str] = []
    lines.append(f"# GitHub security reports — {args.repo}")
    lines.append("")
    lines.append(f"Generated: {now} via `python3 scripts/security-report.py` (read-only `gh api` calls).")
    lines.append("")
    lines.append("Surfaces checked: Dependabot alerts, code scanning (CodeQL), secret scanning, repository advisories.")
    lines.append("")
    lines.append(
        "The file keeps its historical name (`dependabot-alerts.md`) but now covers every GitHub "
        "security surface."
    )
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append("| Surface | Open | Total | Status |")
    lines.append("|---|---|---|---|")
    lines.append(
        f"| Dependabot alerts | {open_dep} | {len(dependabot)} | "
        f"{'action needed' if open_dep else 'clean'} |"
    )
    if codescan is None:
        lines.append("| Code scanning (CodeQL) | - | - | not enabled |")
    else:
        lines.append(
            f"| Code scanning (CodeQL) | {open_scan} | {len(codescan)} | "
            f"{'action needed' if open_scan else 'clean'} |"
        )
    if secretscan is None:
        lines.append("| Secret scanning | - | - | disabled on repo (needs GitHub Advanced Security / public repo) |")
    else:
        open_secret = sum(1 for a in secretscan if a["state"] == "open")
        lines.append(
            f"| Secret scanning | {open_secret} | {len(secretscan)} | "
            f"{'action needed' if open_secret else 'clean'} |"
        )
    lines.append(
        f"| Repository advisories | {sum(1 for a in advisories if a.get('state') == 'published' and not a.get('closed_at'))} | "
        f"{len(advisories)} | {'review' if advisories else 'none'} |"
    )
    lines.append("")
    lines.append(f"Dashboard: https://github.com/{owner}/{name}/security")
    lines.append("")

    lines.extend(render_dependabot(dependabot))
    lines.extend(render_code_scanning(codescan))

    lines.append("## Secret scanning")
    lines.append("")
    if secretscan is None:
        lines.append(
            "Secret scanning is **disabled** on this repository, so GitHub reports no alerts. "
            "Nothing was added here; enable it under Settings → Code security if the repo becomes public "
            "or GHAS is available."
        )
    elif not secretscan:
        lines.append("No secret scanning alerts.")
    else:
        lines.append("| # | Secret type | State | Created | URL |")
        lines.append("|---|---|---|---|---|")
        for a in secretscan:
            lines.append(
                f"| #{a['number']} | {cell(a.get('secret_type_display_name') or a.get('secret_type'))} | "
                f"{cell(a['state'])} | {cell(a.get('created_at'))} | {a['html_url']} |"
            )
    lines.append("")

    lines.append("## Repository security advisories")
    lines.append("")
    if not advisories:
        lines.append("No repository security advisories.")
    else:
        lines.append("| GHSA | Severity | State | Published | Summary |")
        lines.append("|---|---|---|---|---|")
        for a in advisories:
            lines.append(
                f"| {cell(a.get('ghsa_id'))} | {cell(a.get('severity'))} | {cell(a.get('state'))} | "
                f"{cell(a.get('published_at'))} | {cell(a.get('summary'))} |"
            )
    lines.append("")
    lines.append("## Triage notes (hand-written, last reviewed 2026-11-22)")
    lines.append("")
    lines.append(
        "Reading of the code-scanning findings against the code they point at. "
        "Re-check these after refactors — the alerts are re-raised on every CodeQL run."
    )
    lines.append("")
    lines.append("| Rule | Verdict | Why |")
    lines.append("|---|---|---|")
    lines.append(
        "| `rust/hard-coded-cryptographic-value` (18) | false positive — dismissed \"used in tests\" | Every hit is a "
        "`#[test]` fixture (`\"abc123\"` state, `\"nonce-123\"` nonce) in `src-tauri/src/auth.rs` and "
        "`crates/magister-core/src/auth.rs`. No production key material is hard-coded. |"
    )
    lines.append(
        "| `rust/cleartext-logging` (6) | false positive — dismissed | 5 hits are in `crates/spike-password-login`, "
        "which is not shipped (see AGENTS.md) and only prints label + length via `secret_len()`. The sixth hit in "
        "`src-tauri/src/client.rs` logs the keyring *entry name* and the error, never the token value. |"
    )
    lines.append(
        "| `rust/cleartext-transmission` (3) | fixed | The Gemini key travels in the `x-goog-api-key` header in "
        "`src-tauri/src/ai/providers/gemini.rs` and `crates/web-api/src/ai.rs`, not the `?key=` query string. |"
    )
    lines.append(
        "| `rust/request-forgery` (1) | false positive | The Gemini URL in `crates/web-api/src/ai.rs` is fixed; "
        "`check_base_url()` already constrains user-supplied base URLs. |"
    )
    lines.append(
        "| `js/incomplete-multi-character-sanitization` (2), `js/double-escaping` (1) | fixed in 2.19.2 | "
        "`src/lib/html-text.ts` strips tags until nothing tag-shaped is left (then drops stray `<`/`>`) and "
        "decodes entities in a single pass, so `&amp;lt;` can no longer turn into markup. "
        "`htmlToText`/`htmlHasContent` produce plain text only; anything reaching the DOM still goes through "
        "`sanitize.ts`/DOMPurify. |"
    )
    lines.append(
        "| `py/clear-text-storage-sensitive-data` (1) | false positive — dismissed | `scripts/security-report.py` "
        "writes public advisory metadata from read-only `gh api` GETs; no secret values are read or stored. |"
    )
    lines.append("")
    lines.append("Remediation status (2.19.2, pushed 2026-11-22):")
    lines.append("")
    lines.append(
        "1. `dompurify` 3.4.16 → 3.4.18 (patched >= 3.4.17) — the XSS boundary for `{@html}`."
    )
    lines.append(
        "2. `zip` = 8.6.0 → 9.8.1 in `src-tauri/Cargo.lock`; `ZipFile::name()` now returns a `Result`."
    )
    lines.append("3. `rustls` 0.23.43/0.23.44 → 0.23.46 in all four lockfiles.")
    lines.append(
        "4. `vite` 8.3.1 → 8.3.8; `@sveltejs/kit` ^2.70.3 → ^3.4.0 with `@sveltejs/adapter-static` 4.0.1 "
        "(SvelteKit 3 migration completed, not a drive-by bump)."
    )
    lines.append(
        "5. `glib` 0.18.5 remains upstream-blocked: Tauri 2.12.1 still pulls `gtk` 0.18.2, which needs "
        "`glib` 0.18. No released Tauri/GTK stack accepts `glib` 0.20, so alert #23 is dismissed "
        "`tolerable_risk` until Tauri ships a GTK 0.20 stack."
    )
    lines.append(
        "6. Dependabot PRs #30 (rustls 0.23.45) and #31 (vite 8.3.3) closed as superseded by the newer "
        "versions above; no open Dependabot PRs remain."
    )
    lines.append(
        "7. Secret scanning and push protection enabled on the public repo (2026-11-22)."
    )
    lines.append("")
    lines.append(
        "Any remaining open CodeQL hit is re-raised per push; fix it in code or dismiss it from "
        "Security → Code scanning with a reason."
    )
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append(
        "Regenerate with `python3 scripts/security-report.py`. Alerts are a snapshot: GitHub keeps "
        "re-evaluating them as manifests change, so rerun after dependency bumps."
    )
    lines.append("")

    path = args.out
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    print(f"wrote {path}: dependabot {open_dep} open/{len(dependabot)} total, "
          f"code scanning {open_scan} open/{len(codescan or [])} total")


if __name__ == "__main__":
    main()
