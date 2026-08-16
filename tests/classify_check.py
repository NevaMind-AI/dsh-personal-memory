"""Cross-check: does memU actually bucket the rows this plugin writes?

The memorization seam's whole claim is that its JSONL lands in a dialect memU's
generic adapter recognizes — conversation as MESSAGE, tool traffic as TOOL. The
TypeScript suite pins the row *shapes*; only memU can confirm the *verdicts*, so
this runs those shapes through ``GenericTranscriptSource`` itself rather than
through our reading of it.

It also covers the truncated forms, because a bound that silently changed a row's
classification would quietly drop tool traffic out of memU's skill job.

Run it against a memU checkout::

    git clone https://github.com/NevaMind-AI/MemU
    PYTHONPATH=MemU/src python3 tests/classify_check.py

Classification is pure: no memU configuration and no backend are needed.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

try:
    from memu.hosts.base import RecordKind
    from memu.hosts.generic.sessions import GenericTranscriptSource
except ImportError as error:  # pragma: no cover - the guard is the error message
    sys.exit(
        f"memU is not importable ({error}). Clone https://github.com/NevaMind-AI/MemU and run:\n"
        "  PYTHONPATH=MemU/src python3 tests/classify_check.py"
    )

TIMESTAMP = "2026-11-14T22:13:20+00:00"
TRUNCATED = "\n… [truncated by memory-memu at 4000 characters]"


def row(**fields: object) -> str:
    """One line exactly as `sessionEventToTranscriptRecord` serializes it."""
    return json.dumps({"timestamp": TIMESTAMP, "session_id": "session-a", "dsh_seq": 1, **fields})


CASES: list[tuple[str, str, RecordKind]] = [
    (
        "direct user message",
        row(role="user", content=[{"type": "text", "text": "Remember oolong."}]),
        RecordKind.MESSAGE,
    ),
    (
        "assistant message",
        row(role="assistant", content=[{"type": "text", "text": "Noted."}]),
        RecordKind.MESSAGE,
    ),
    (
        "tool call",
        row(
            role="assistant",
            content=None,
            tool_calls=[{"id": "call-1", "type": "function",
                         "function": {"name": "bash", "arguments": "{}"}}],
        ),
        RecordKind.TOOL,
    ),
    (
        "tool result",
        row(
            role="tool",
            tool_call_id="call-1",
            content=[{"type": "tool-result", "toolCallId": "call-1",
                      "content": [{"type": "text", "text": "ok"}]}],
        ),
        RecordKind.TOOL,
    ),
    # The bound must not move a row between buckets.
    (
        "truncated tool result",
        row(role="tool", tool_call_id="call-1",
            content=[{"type": "text", "text": "[{\"type\":\"tool-result\"" + TRUNCATED}]),
        RecordKind.TOOL,
    ),
    (
        "truncated tool call",
        row(
            role="assistant",
            content=None,
            tool_calls=[{"id": "call-1", "type": "function",
                         "function": {"name": "write", "arguments": "{\"content\":\"xxx" + TRUNCATED}}],
        ),
        RecordKind.TOOL,
    ),
    (
        "truncated user message",
        row(role="user", content=[{"type": "text", "text": "[{\"type\":\"text\"" + TRUNCATED}]),
        RecordKind.MESSAGE,
    ),
]


def main() -> int:
    source = GenericTranscriptSource(Path("/nonexistent"))
    failures = 0
    for label, line, expected in CASES:
        actual = source.classify(line)
        if actual != expected:
            failures += 1
            print(f"FAIL  {label:<24} expected {expected.value}, got {actual.value}")
            continue
        if source.timestamp(line) != TIMESTAMP:
            failures += 1
            print(f"FAIL  {label:<24} timestamp not read back: {source.timestamp(line)!r}")
            continue
        print(f"PASS  {label:<24} {actual.value}")
    print("\nevery row classified as intended" if not failures else f"\n{failures} check(s) failed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
