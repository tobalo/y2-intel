from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
from collections.abc import Sequence


MIB = 1_048_576
DEFAULT_WARNING_BYTES = 52_429
SHA_PATTERN = re.compile(r"[0-9a-f]{40}")
TARGET_PATTERN = re.compile(r"[A-Za-z0-9_.-]+")
SEGMENT_PATTERN = re.compile(r"^Segment\s+(\S+):\s+(\d+)")
SECTION_PATTERN = re.compile(r"^Section\s+(\S+):\s+(\d+)")
ELF_SECTION_PATTERN = re.compile(r"^(\S+)\s+(\d+)\s+(?:0x)?[0-9A-Fa-f]+$")


class BinarySizeError(RuntimeError):
    pass


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def artifact_evidence(path: pathlib.Path, source_sha: str) -> dict[str, object]:
    if not path.is_file() or path.stat().st_size <= 0:
        raise BinarySizeError(f"binary is missing or empty: {path}")
    size_bytes = path.stat().st_size
    return {
        "source_sha": source_sha,
        "sha256": sha256_file(path),
        "size_bytes": size_bytes,
        "size_mib": size_bytes / MIB,
    }


def parse_macho_sections(path: pathlib.Path) -> tuple[dict[str, int], dict[str, int]]:
    if not path.is_file():
        raise BinarySizeError(f"section report does not exist: {path}")
    segments: dict[str, int] = {}
    sections: dict[str, int] = {}
    seen_segments: set[str] = set()
    current_segment: str | None = None
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        segment_match = SEGMENT_PATTERN.match(line)
        if segment_match:
            current_segment = segment_match.group(1)
            if current_segment in seen_segments:
                raise BinarySizeError(
                    "section report contains duplicate segment "
                    f"{current_segment}: {path}"
                )
            seen_segments.add(current_segment)
            if current_segment != "__PAGEZERO":
                segments[current_segment] = int(segment_match.group(2))
            continue
        section_match = SECTION_PATTERN.match(line)
        if section_match and current_segment and current_segment != "__PAGEZERO":
            key = f"{current_segment}.{section_match.group(1)}"
            if key in sections:
                raise BinarySizeError(
                    f"section report contains duplicate section {key}: {path}"
                )
            sections[key] = int(section_match.group(2))
    if not segments:
        raise BinarySizeError(f"section report contains no Mach-O segments: {path}")
    if "__TEXT" not in segments:
        raise BinarySizeError(f"section report is missing __TEXT segment: {path}")
    return segments, sections


def parse_elf_sections(path: pathlib.Path) -> tuple[dict[str, int], dict[str, int]]:
    if not path.is_file():
        raise BinarySizeError(f"section report does not exist: {path}")
    sections: dict[str, int] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        section_match = ELF_SECTION_PATTERN.match(raw_line.strip())
        if not section_match:
            continue
        name = section_match.group(1)
        if name in sections:
            raise BinarySizeError(
                f"section report contains duplicate section {name}: {path}"
            )
        sections[name] = int(section_match.group(2))
    if not sections:
        raise BinarySizeError(f"section report contains no ELF sections: {path}")
    if ".text" not in sections:
        raise BinarySizeError(f"section report is missing .text section: {path}")
    return {}, sections


def parse_sections(
    path: pathlib.Path,
    target: str,
) -> tuple[dict[str, int], dict[str, int]]:
    if target.endswith("-macos"):
        return parse_macho_sections(path)
    if target.endswith("-linux"):
        return parse_elf_sections(path)
    raise BinarySizeError(f"unsupported target: {target}")


def deltas(base: dict[str, int], head: dict[str, int]) -> dict[str, int]:
    return {
        key: head.get(key, 0) - base.get(key, 0)
        for key in sorted(set(base) | set(head))
        if head.get(key, 0) != base.get(key, 0)
    }


def build_report(
    *,
    base_binary: pathlib.Path,
    head_binary: pathlib.Path,
    base_sections: pathlib.Path,
    head_sections: pathlib.Path,
    base_sha: str,
    head_sha: str,
    target: str,
    warning_bytes: int,
) -> dict[str, object]:
    if not SHA_PATTERN.fullmatch(base_sha) or not SHA_PATTERN.fullmatch(head_sha):
        raise BinarySizeError("source SHAs must be lowercase 40-character hex values")
    if not TARGET_PATTERN.fullmatch(target):
        raise BinarySizeError(f"invalid target: {target!r}")
    if warning_bytes <= 0:
        raise BinarySizeError("warning threshold must be positive")

    base = artifact_evidence(base_binary, base_sha)
    head = artifact_evidence(head_binary, head_sha)
    base_segments, base_section_values = parse_sections(base_sections, target)
    head_segments, head_section_values = parse_sections(head_sections, target)
    delta_bytes = int(head["size_bytes"]) - int(base["size_bytes"])
    if delta_bytes > 0:
        direction = "increase"
    elif delta_bytes < 0:
        direction = "decrease"
    else:
        direction = "unchanged"
    return {
        "schema_version": 1,
        "status": "warning" if delta_bytes >= warning_bytes else "ok",
        "target": target,
        "warning_threshold_bytes": warning_bytes,
        "base": base,
        "head": head,
        "delta": {
            "direction": direction,
            "size_bytes": delta_bytes,
            "size_mib": delta_bytes / MIB,
            "percent": (delta_bytes / int(base["size_bytes"])) * 100,
        },
        "segment_deltas_bytes": deltas(base_segments, head_segments),
        "section_deltas_bytes": deltas(base_section_values, head_section_values),
    }


def signed_bytes(value: int) -> str:
    return f"{value:+,} bytes"


def append_delta_table(
    lines: list[str],
    heading: str,
    values: dict[str, int],
    *,
    limit: int | None = None,
) -> None:
    lines.extend(["", heading, ""])
    ranked = sorted(values.items(), key=lambda item: (-abs(item[1]), item[0]))
    if limit is not None:
        ranked = ranked[:limit]
    if not ranked:
        lines.append("No changes detected.")
        return
    lines.extend(["| Name | Change in bytes |", "| --- | ---: |"])
    lines.extend(f"| `{name}` | {value:+,} |" for name, value in ranked)


def markdown_report(report: dict[str, object]) -> str:
    base = report["base"]
    head = report["head"]
    delta = report["delta"]
    assert isinstance(base, dict)
    assert isinstance(head, dict)
    assert isinstance(delta, dict)
    status = str(report["status"])
    direction = str(delta["direction"])
    if status == "warning":
        warning_bytes = int(report["warning_threshold_bytes"])
        signal = (
            "Review recommended: the increase meets the informational threshold of "
            f"{warning_bytes:,} bytes ({warning_bytes / MIB:.6f} MiB)."
        )
    elif direction == "decrease":
        signal = "The PR binary is smaller than the base binary."
    elif direction == "unchanged":
        signal = "The PR and base binaries have the same file size."
    else:
        signal = "The increase is within the informational warning threshold."
    lines: list[str] = [
        "# Binary size",
        "",
        "This comparison is informational. "
        "Release PGSO qualification remains authoritative.",
        "",
        f"Target: `{report['target']}`",
        "",
        "| Artifact | Bytes | MiB | Source | SHA-256 |",
        "| --- | ---: | ---: | --- | --- |",
        (
            f"| Base | {int(base['size_bytes']):,} | "
            f"{float(base['size_mib']):.6f} | `{base['source_sha']}` | "
            f"`{base['sha256']}` |"
        ),
        (
            f"| PR | {int(head['size_bytes']):,} | "
            f"{float(head['size_mib']):.6f} | `{head['source_sha']}` | "
            f"`{head['sha256']}` |"
        ),
        "",
        (
            f"Change: **{signed_bytes(int(delta['size_bytes']))}** "
            f"({float(delta['size_mib']):+.6f} MiB, "
            f"{float(delta['percent']):+.3f}%)."
        ),
        "",
        signal,
    ]
    segment_deltas = report["segment_deltas_bytes"]
    section_deltas = report["section_deltas_bytes"]
    assert isinstance(segment_deltas, dict)
    assert isinstance(section_deltas, dict)
    append_delta_table(lines, "## Segment changes", segment_deltas)
    append_delta_table(
        lines,
        "## Largest section changes",
        section_deltas,
        limit=10,
    )
    return "\n".join(lines) + "\n"


def parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare stripped ReleaseSafe y2 binaries",
    )
    parser.add_argument("--base-binary", type=pathlib.Path, required=True)
    parser.add_argument("--head-binary", type=pathlib.Path, required=True)
    parser.add_argument("--base-sections", type=pathlib.Path, required=True)
    parser.add_argument("--head-sections", type=pathlib.Path, required=True)
    parser.add_argument("--base-sha", required=True)
    parser.add_argument("--head-sha", required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument(
        "--warning-bytes",
        type=int,
        default=DEFAULT_WARNING_BYTES,
    )
    parser.add_argument("--output-json", type=pathlib.Path, required=True)
    parser.add_argument("--output-markdown", type=pathlib.Path, required=True)
    parser.add_argument("--github-output", type=pathlib.Path)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        report = build_report(
            base_binary=args.base_binary,
            head_binary=args.head_binary,
            base_sections=args.base_sections,
            head_sections=args.head_sections,
            base_sha=args.base_sha,
            head_sha=args.head_sha,
            target=args.target,
            warning_bytes=args.warning_bytes,
        )
    except BinarySizeError as error:
        raise SystemExit(str(error)) from error

    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    args.output_markdown.parent.mkdir(parents=True, exist_ok=True)
    args.output_json.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    args.output_markdown.write_text(markdown_report(report), encoding="utf-8")
    if args.github_output:
        warning = str(report["status"] == "warning").lower()
        delta = report["delta"]
        assert isinstance(delta, dict)
        args.github_output.write_text(
            f"warning={warning}\n"
            f"delta_bytes={int(delta['size_bytes'])}\n"
            f"status={report['status']}\n",
            encoding="utf-8",
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
