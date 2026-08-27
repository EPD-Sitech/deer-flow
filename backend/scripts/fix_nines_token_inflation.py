"""Repair token counts inflated by the oneai relay's per-chunk ``usage`` bug.

Background
----------
The oneai transit relay echoes the full ``usage`` object in *every* streaming
chunk for some models (``Nines-N3.1``). ``langchain_openai`` sums the per-chunk
``usage``, so a run's stored token totals were multiplied by the number of
streaming chunks (observed ~784x). oneai's own platform reports the correct
total, and the patched adapter (``deerflow/models/patched_oneai.py``) now
prevents this for *future* runs. This script repairs *historical* rows.

The repair factor defaults to 784, calibrated from the oneai-verified total for
user ``zhongpq`` (correct 4,842,974 / inflated 3,796,757,840 ≈ 784). Token
counts are approximate after repair — exact per-run values would need to be
re-pulled from oneai's billing API — but the dashboard magnitudes become sane
and internally consistent.

Usage
-----
    # Preview what would change (no writes):
    python scripts/fix_nines_token_inflation.py --dsn "$DATABASE_URL"

    # Apply:
    python scripts/fix_nines_token_inflation.py --dsn "$DATABASE_URL" --apply
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import psycopg

# Calibrated from oneai's verified total for zhongpq:
#   3,796,757,840 (inflated, as stored) / 4,842,974 (oneai correct) ≈ 784.
DEFAULT_FACTOR = 784.0
# Runs whose average tokens-per-call exceed this are treated as inflated.
# Normal models report ~50k–70k/call; the buggy Nines runs report ~8–10M/call.
DEFAULT_THRESHOLD = 200_000


def _scale_json_usage(token_usage_by_model: dict | None, factor: float) -> dict | None:
    """Scale every numeric field inside each model bucket by ``factor``."""
    if not token_usage_by_model:
        return token_usage_by_model
    out: dict[str, dict] = {}
    for model, usage in token_usage_by_model.items():
        if not isinstance(usage, dict):
            out[model] = usage
            continue
        scaled = {k: (int(round((v or 0) / factor)) if isinstance(v, (int, float)) else v) for k, v in usage.items()}
        out[model] = scaled
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dsn",
        default=os.environ.get("DATABASE_URL"),
        help="Postgres DSN (defaults to $DATABASE_URL).",
    )
    parser.add_argument("--factor", type=float, default=DEFAULT_FACTOR)
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    parser.add_argument("--apply", action="store_true", help="Actually write changes (default: dry-run).")
    args = parser.parse_args()

    if not args.dsn:
        print("ERROR: no --dsn and $DATABASE_URL is unset", file=sys.stderr)
        return 2

    conn = psycopg.connect(args.dsn)
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT run_id, total_tokens, total_input_tokens, total_output_tokens,
                   lead_agent_tokens, subagent_tokens, middleware_tokens,
                   token_usage_by_model, llm_call_count
            FROM deerflow.runs
            WHERE operation_kind = 'run'
              AND lower(model_name) LIKE %s
              AND (total_tokens::float / NULLIF(llm_call_count, 0)) > %s
            ORDER BY total_tokens DESC
            """,
            ("%nines%", args.threshold),
        )
        rows = cur.fetchall()
        print(f"Dry-run={not args.apply}  factor={args.factor}  threshold(avg/call)={args.threshold}")
        print(f"Inflated Nines runs to repair: {len(rows)}\n")

        before_all = after_all = 0
        for (
            run_id,
            total,
            tin,
            tout,
            lead,
            sub,
            mid,
            usage_json,
            calls,
        ) in rows:
            before_all += int(total or 0)
            new_total = int(round((total or 0) / args.factor))
            new_in = int(round((tin or 0) / args.factor))
            new_out = int(round((tout or 0) / args.factor))
            new_lead = int(round((lead or 0) / args.factor))
            new_sub = int(round((sub or 0) / args.factor))
            new_mid = int(round((mid or 0) / args.factor))
            new_usage = _scale_json_usage(usage_json, args.factor)
            after_all += new_total
            print(f"  {str(run_id)[:8]} calls={calls} total {int(total):>14} -> {new_total:>12}")
            if args.apply:
                cur.execute(
                    """
                    UPDATE deerflow.runs
                    SET total_tokens = %s,
                        total_input_tokens = %s,
                        total_output_tokens = %s,
                        lead_agent_tokens = %s,
                        subagent_tokens = %s,
                        middleware_tokens = %s,
                        token_usage_by_model = %s
                    WHERE run_id = %s
                    """,
                    (
                        new_total,
                        new_in,
                        new_out,
                        new_lead,
                        new_sub,
                        new_mid,
                        json.dumps(new_usage) if new_usage is not None else None,
                        run_id,
                    ),
                )

        print(f"\nTotal (these runs): before={before_all} after={after_all}")
        if args.apply:
            conn.commit()
            print("Committed.")
        else:
            conn.rollback()
            print("Rolled back (dry-run). Re-run with --apply to write.")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
