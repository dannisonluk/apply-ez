"""
Validate the SQL migrations.

Two layers, because neither alone is enough:

  1. pglast wraps libpg_query — the actual PostgreSQL parser — so the DDL, policies
     and GRANT/REVOKE statements are checked against real grammar rather than a
     regular expression. It does NOT parse plpgsql function bodies (libpg_query
     treats a `$$ … $$` body as an opaque string).
  2. So the bodies get their own structural checks: balanced dollar quoting, and
     balanced BEGIN/END per body.

   python scripts/check-sql.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

from pglast import parse_sql

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = sorted((ROOT / "supabase" / "migrations").glob("*.sql"))

failures: list[str] = []
checks = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global checks
    checks += 1
    if not ok:
        failures.append(f"{name}{f' — {detail}' if detail else ''}")


def strip_noise(body: str) -> str:
    """Blank out comments and literals so keywords inside them do not get counted.

    Replaced with spaces (not removed) to keep offsets, which makes any future
    error message still point at the right place.
    """
    body = re.sub(r"/\*.*?\*/", " ", body, flags=re.DOTALL)
    body = re.sub(r"--[^\n]*", " ", body)
    body = re.sub(r"'(?:[^']|'')*'", " ", body)
    body = re.sub(r'"(?:[^"]|"")*"', " ", body)
    return body


def count_blocks(body: str) -> tuple[int, int]:
    """Count plpgsql block openers and their real terminators.

    `BEGIN` opens a block, but `END` terminates four different things:
      * `END;`        — closes the block (what we are counting)
      * `END IF;`     — closes an IF
      * `END LOOP;`   — closes a LOOP
      * `END CASE;`   — closes a CASE *statement*
    and a bare `END` also closes a CASE *expression* (`select case … end`).

    So the raw `end` count is always >= the block count; subtracting the other
    roles is what makes the comparison meaningful.

    Watch out: `\\bcase\\b` matches BOTH the CASE keyword and the `case` inside
    `end case`, so the raw count double-counts CASE statements. That off-by-one is
    the reason a CASE statement used to look like a CASE expression here.
    """
    body = strip_noise(body)
    begins = len(re.findall(r"\bbegin\b", body, flags=re.I))
    ends = len(re.findall(r"\bend\b", body, flags=re.I))
    end_if = len(re.findall(r"\bend\s+if\b", body, flags=re.I))
    end_loop = len(re.findall(r"\bend\s+loop\b", body, flags=re.I))
    end_case_stmt = len(re.findall(r"\bend\s+case\b", body, flags=re.I))
    # `case` occurrences minus those that are the tail of `end case` = real openers.
    case_openers = len(re.findall(r"\bcase\b", body, flags=re.I)) - end_case_stmt
    # Of those openers, the statement form is closed by `END CASE`; the rest are
    # expressions, closed by a bare `END`.
    case_expr = max(0, case_openers - end_case_stmt)
    block_ends = ends - end_if - end_loop - end_case_stmt - case_expr
    return begins, block_ends


def self_test() -> None:
    """Feed the counter known-good and known-bad bodies.

    Without this, a counter that always returns (1, 1) would report every
    migration as clean. The two deliberately-broken cases prove it can fail.
    """
    cases: list[tuple[str, str, int, int]] = [
        ("plain block", "begin return 1; end;", 1, 1),
        ("if block", "begin if x then return 1; end if; end;", 1, 1),
        ("nested ifs", "begin if a then if b then null; end if; end if; end;", 1, 1),
        ("case expression", "begin select case k when 1 then a end into v; end;", 1, 1),
        ("case statement", "begin case k when 1 then null; end case; end;", 1, 1),
        ("case statement + if", "begin case k when 1 then null; end case; if x then null; end if; end;", 1, 1),
        ("loop", "begin loop exit; end loop; end;", 1, 1),
        ("no begin (sql body)", "select public.f(1);", 0, 0),
        ("missing final end", "begin if x then return 1; end if;", 1, 0),
        ("extra end", "begin return 1; end; end;", 1, 2),
        ("line comment ignored", "begin -- end end end\nreturn 1; end;", 1, 1),
        ("string literal ignored", "begin raise notice 'end begin end'; end;", 1, 1),
    ]
    for name, body, want_begins, want_ends in cases:
        got = count_blocks(body)
        check(
            f"self-test: counter handles {name}",
            got == (want_begins, want_ends),
            f"got {got}, want {(want_begins, want_ends)}",
        )


self_test()


for path in MIGRATIONS:
    sql = path.read_text(encoding="utf-8")
    label = path.name

    # ── 1. real-grammar parse ────────────────────────────────────────────────
    try:
        statements = parse_sql(sql)
        check(f"{label}: parses as PostgreSQL", True)
    except Exception as exc:  # noqa: BLE001 — surface whatever the parser says
        check(f"{label}: parses as PostgreSQL", False, str(exc))
        statements = []

    print(f"{label}: {len(statements)} top-level statements")

    # ── 2. dollar quoting ────────────────────────────────────────────────────
    # Every `$$` toggles in/out of a body, so the count must be even and no body
    # may be left open at EOF.
    opens = sql.count("$$")
    check(f"{label}: dollar quotes are balanced", opens % 2 == 0, f"found {opens}")

    # ── 3. BEGIN/END balance per function body ───────────────────────────────
    for match in re.finditer(r"\$\$(.*?)\$\$", sql, flags=re.DOTALL):
        body = match.group(1)
        begins, block_ends = count_blocks(body)
        # A body that is a single `select …` has no BEGIN at all, which is fine.
        if begins == 0:
            check(f"{label}: SQL-language body has no stray END", block_ends == 0, body.strip()[:60])
        else:
            check(
                f"{label}: plpgsql body BEGIN/END balanced",
                begins == block_ends,
                f"{begins} BEGIN vs {block_ends} block-closing END",
            )

    # ── 4. every GRANT/REVOKE names a function that this repo defines ────────
    # A typo in an argument list here fails at apply time with a confusing error,
    # so it is worth cross-checking statically.
    defined = set(re.findall(r"create or replace function public\.(\w+)\s*\(", sql, re.I))
    for fn in re.findall(r"on function public\.(\w+)\s*\(", sql, re.I):
        check(f"{label}: grant/revoke target `{fn}` is defined", fn in defined, f"defined: {sorted(defined)}")

    # ── 5. SECURITY DEFINER functions pin their search_path ──────────────────
    # Without this a caller can shadow `crypt` with their own function and read the
    # codes out of the comparison.
    definers = re.findall(
        r"create or replace function public\.(\w+)\s*\([^)]*\)(.*?)\$\$",
        sql,
        flags=re.DOTALL | re.IGNORECASE,
    )
    for name, header in definers:
        if "security definer" in header.lower():
            check(
                f"{label}: `{name}` pins search_path",
                "set search_path" in header.lower(),
                header.strip()[:80],
            )

    # ── 6. no function is left executable by PUBLIC ──────────────────────────
    # Postgres grants EXECUTE to PUBLIC by default, so a revoke that only names
    # anon/authenticated leaves the function wide open.
    for fn in defined:
        if f"revoke all on function public.{fn}" in sql.lower():
            revoke_clause = re.search(
                rf"revoke all on function public\.{fn}\([^)]*\)\s*from([^;]*);", sql, re.I
            )
            if revoke_clause:
                check(
                    f"{label}: `{fn}` revoked from PUBLIC",
                    "public" in revoke_clause.group(1).lower(),
                    revoke_clause.group(1).strip(),
                )

if failures:
    print(f"\n{len(failures)} FAILED:")
    for failure in failures:
        print(f"  x {failure}")
    print(f"\n{checks - len(failures)} passed, {len(failures)} failed")
    sys.exit(1)

print(f"\n{checks} SQL assertions passed")
