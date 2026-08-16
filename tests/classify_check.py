"""Cross-check: does memU actually bucket what this plugin writes?

The write-back seam's whole claim is that its JSONL lands in a dialect memU's
generic adapter recognizes — conversation as MESSAGE, tool traffic as TOOL. That
claim is only worth anything if it is checked against memU's real classifier
rather than against our reading of it, so this runs the fixtures through
``GenericTranscriptSource`` itself.

Run it against a memU checkout::

    PYTHONPATH=/path/to/MemU/src python3 tests/classify_check.py

It needs no memU configuration and no backend: classification is pure.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

try:
    from memu.hosts.base import RecordKind
    from memu.hosts.generic.sessions import GenericTranscriptSource
except ImportError:  # pragma: no cover - the guard is the error message
    sys.exit(
        "memU is not importable. Clone https://github.com/NevaMind-AI/MemU and run:\n"
        "  PYTHONPATH=/path/to/MemU/src python3 tests/classify_check.py"
    )

TIMESTAMP = "2026-08-16T12:00:00.000Z"


def record(kind: str, content: list[dict[str, object]]) -> str:
    """One line exactly as `toMemuRecord` serializes it."""
    return json.dumps(
        {
            "type": kind,
            "timestamp": TIMESTAMP,
            "sessionId": "sess-1",
            "host": "dsh",
            "message": {"role": kind, "content": content},
        }
    )

# Mirrors tests/transcript.test.js. Each entry is what memU must conclude.
CASES: list[tuple[str, str, RecordKind]] = [
    (
        "user text",
        record("user", [{"type": "text", "text": "always deploy with the staging flag first"}]),
        RecordKind.MESSAGE,
    ),
    (
        "assistant text",
        record("assistant", [{"type": "text", "text": "Deploying to staging."}]),
        RecordKind.MESSAGE,
    ),
    (
        "tool call",
        record("assistant", [{"type": "tool_use", "id": "call-7", "name": "bash", "input": {"command": "pnpm build"}}]),
        RecordKind.TOOL,
    ),
    (
        "tool result",
        record("user", [{"type": "tool_result", "tool_use_id": "call-7", "content": "ok"}]),
        RecordKind.TOOL,
    ),
]


def main() -> int:
    source = GenericTranscriptSource(Path("/nonexistent"))
    failures = 0
    for label, line, expected in CASES:
        actual = source.classify(line)
        ok = actual == expected
        failures += not ok
        print(f"{'PASS' if ok else 'FAIL'}  {label:<16} expected {expected.value:<8} got {actual.value}")
        if source.timestamp(line) != TIMESTAMP:
            failures += 1
            print(f"FAIL  {label:<16} timestamp not read back: {source.timestamp(line)!r}")
    print("\nall records classified as intended" if not failures else f"\n{failures} check(s) failed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
