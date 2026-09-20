"""Personal Activity: a single user's own footprint in Git Walk — repository
access, commits, cells touched, and AI usage — over a selectable time range,
plus a GitHub-style daily activity heatmap and a real (not invented)
comparison against teammates.

Every number here is read straight from existing, already-populated tables
(``REPOSITORY_MEMBERS``, ``COMMITS``, ``AI_REQUESTS``, ``AI_MODELS``) —
nothing is seeded or hardcoded. ``REPOSITORY_MEMBERS`` is the same table
``dataset_store.list_datasets()`` uses for its own "can this user see this
repository" check, so "Repositories" here matches what the rest of the
product means by repository access. The heatmap window is capped at 371
days (53 weeks), the same convention GitHub's own contribution graph uses,
regardless of the requested range, so "all" stays a fixed-size, renderable
grid rather than an unbounded one.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from .. import database
from .service import _row

_RANGE_DAYS = {"7d": 7, "30d": 30}
_HEATMAP_MAX_DAYS = 371


def _since_for_range(range_key: str, user_created_at: str) -> str:
    if range_key in _RANGE_DAYS:
        return (datetime.now(timezone.utc) - timedelta(days=_RANGE_DAYS[range_key])).isoformat()
    return user_created_at


def _format_hour(hour: int) -> str:
    if hour == 0:
        return "12 AM"
    if hour < 12:
        return f"{hour} AM"
    if hour == 12:
        return "12 PM"
    return f"{hour - 12} PM"


def _longest_streak(heatmap: list[dict[str, Any]]) -> int:
    best = current = 0
    for day in heatmap:
        if day["count"] > 0:
            current += 1
            best = max(best, current)
        else:
            current = 0
    return best


def _busiest_day(heatmap: list[dict[str, Any]]) -> dict[str, Any] | None:
    candidates = [day for day in heatmap if day["count"] > 0]
    if not candidates:
        return None
    return max(candidates, key=lambda day: day["count"])


def personal_activity(organization_id: str, user_id: str, range_key: str = "30d") -> dict[str, Any]:
    range_key = range_key if range_key in {"7d", "30d", "all"} else "30d"
    conn = database._get_connection()
    try:
        user_row = conn.execute("SELECT CREATED_AT FROM APP_USERS WHERE USER_ID=?", (user_id,)).fetchone()
        user_created_at = user_row["CREATED_AT"] if user_row else datetime.now(timezone.utc).isoformat()
        since = _since_for_range(range_key, user_created_at)

        commit_rows = conn.execute(
            "SELECT CREATED_AT, CHANGE_COUNT, REPOSITORY_ID FROM COMMITS WHERE AUTHOR_USER_ID=? AND CREATED_AT>=?",
            (user_id, since),
        ).fetchall()
        ai_rows = conn.execute(
            """SELECT CREATED_AT, MODEL_ID, STATUS, LATENCY_MS,
                      INPUT_TOKENS, OUTPUT_TOKENS, REASONING_TOKENS
               FROM AI_REQUESTS WHERE USER_ID=? AND ORGANIZATION_ID=? AND CREATED_AT>=?""",
            (user_id, organization_id, since),
        ).fetchall()
        repository_count = conn.execute(
            """SELECT COUNT(*) FROM REPOSITORY_MEMBERS M
               JOIN WORKBOOK_REPOSITORIES R ON R.REPOSITORY_ID=M.REPOSITORY_ID
               WHERE M.USER_ID=? AND R.STATUS='ACTIVE'""",
            (user_id,),
        ).fetchone()[0]

        daily_counts: dict[str, int] = {}
        hourly_counts: dict[int, int] = {}
        active_days: set[str] = set()

        def _bucket(created_at: str) -> None:
            if not created_at or len(created_at) < 10:
                return
            day = created_at[:10]
            daily_counts[day] = daily_counts.get(day, 0) + 1
            active_days.add(day)
            if len(created_at) >= 13:
                try:
                    hour = int(created_at[11:13])
                except ValueError:
                    return
                hourly_counts[hour] = hourly_counts.get(hour, 0) + 1

        cells_changed = 0
        repositories_touched: set[str] = set()
        for row in commit_rows:
            _bucket(row["CREATED_AT"])
            cells_changed += row["CHANGE_COUNT"] or 0
            repositories_touched.add(row["REPOSITORY_ID"])
        for row in ai_rows:
            _bucket(row["CREATED_AT"])

        model_names = {row["MODEL_ID"]: row["DISPLAY_NAME"] for row in conn.execute("SELECT MODEL_ID,DISPLAY_NAME FROM AI_MODELS")}

        model_stats: dict[str, dict[str, Any]] = {}
        total_tokens = 0
        for row in ai_rows:
            item = _row(row)
            tokens = (item["input_tokens"] or 0) + (item["output_tokens"] or 0) + (item["reasoning_tokens"] or 0)
            total_tokens += tokens
            key = item["model_id"] or "unknown"
            bucket = model_stats.setdefault(key, {
                "model_id": key, "display_name": model_names.get(key, key or "Unknown model"),
                "requests": 0, "succeeded": 0, "failed": 0, "tokens": 0, "latencies": [],
            })
            bucket["requests"] += 1
            bucket["tokens"] += tokens
            if item["status"] == "COMPLETED":
                bucket["succeeded"] += 1
            elif item["status"] == "FAILED":
                bucket["failed"] += 1
            if item["latency_ms"]:
                bucket["latencies"].append(item["latency_ms"])

        models = []
        for bucket in model_stats.values():
            latencies = bucket.pop("latencies")
            bucket["avg_latency_ms"] = round(sum(latencies) / len(latencies), 2) if latencies else 0.0
            bucket["success_rate"] = round(bucket["succeeded"] / bucket["requests"], 3) if bucket["requests"] else 0.0
            models.append(bucket)
        models.sort(key=lambda item: item["tokens"], reverse=True)

        peak_hour = None
        if hourly_counts:
            peak_hour = _format_hour(max(hourly_counts, key=lambda hour: hourly_counts[hour]))

        heatmap_start = datetime.now(timezone.utc) - timedelta(days=_HEATMAP_MAX_DAYS - 1)
        since_dt = datetime.fromisoformat(since.replace("Z", "+00:00")) if since else heatmap_start
        if since_dt.tzinfo is None:
            since_dt = since_dt.replace(tzinfo=timezone.utc)
        heatmap_start = max(heatmap_start, since_dt)
        today = datetime.now(timezone.utc)
        heatmap = []
        cursor = heatmap_start.replace(hour=0, minute=0, second=0, microsecond=0)
        end = today.replace(hour=0, minute=0, second=0, microsecond=0)
        while cursor <= end:
            key = cursor.strftime("%Y-%m-%d")
            heatmap.append({"date": key, "count": daily_counts.get(key, 0)})
            cursor += timedelta(days=1)

        longest_streak = _longest_streak(heatmap)
        busiest = _busiest_day(heatmap)
        busiest_day_label = None
        if busiest:
            busiest_date = datetime.strptime(busiest["date"], "%Y-%m-%d")
            busiest_day_label = f"{busiest_date.strftime('%b %d')} · {busiest['count']} event{'s' if busiest['count'] != 1 else ''}"

        peer_rows = conn.execute(
            """SELECT USER_ID, COALESCE(SUM(INPUT_TOKENS+OUTPUT_TOKENS+REASONING_TOKENS),0) AS TOKENS
               FROM AI_REQUESTS WHERE ORGANIZATION_ID=? AND CREATED_AT>=? GROUP BY USER_ID""",
            (organization_id, since),
        ).fetchall()
        peer_totals = [row["TOKENS"] for row in peer_rows if row["USER_ID"] != user_id]
        comparison: dict[str, Any] = {"multiplier": None, "message": "Not enough teammate activity yet for a comparison."}
        if peer_totals:
            avg_peer_tokens = sum(peer_totals) / len(peer_totals)
            if avg_peer_tokens > 0:
                multiplier = round(total_tokens / avg_peer_tokens, 1)
                comparison = {
                    "multiplier": multiplier,
                    "message": f"You've used ~{multiplier}x the average teammate's AI token usage this period.",
                }
            elif total_tokens > 0:
                comparison = {"multiplier": None, "message": "You're the only one generating AI usage this period."}

        return {
            "range": range_key,
            "since": since,
            "overview": {
                "repositories": repository_count,
                "repositories_touched": len(repositories_touched),
                "commits": len(commit_rows),
                "cells_changed": cells_changed,
                "total_tokens": total_tokens,
                "active_days": len(active_days),
                "longest_streak": longest_streak,
                "busiest_day": busiest_day_label,
                "peak_hour": peak_hour,
            },
            "heatmap": heatmap,
            "models": models,
            "comparison": comparison,
        }
    finally:
        conn.close()
