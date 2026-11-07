#!/usr/bin/env python3
"""Local fail-closed Finny spreadsheet engine for Mac staging.

Accepts QM's spreadsheet-engine v1 request over HTTPS, recalculates .xlsx files
with LibreOffice, and returns strictly typed evidence for the three deterministic
checks. It binds only to loopback and never persists workbook bytes.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import math
import os
import re
import ssl
import subprocess
import tempfile
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable

from openpyxl import load_workbook
from openpyxl.utils.cell import range_boundaries

CHECKS = ("formula.recalculate", "summary.crossfoot", "artifact.structure")
FORMULA_ERROR_PREFIX = "#"
SUM_RE = re.compile(r"^\s*=\s*SUM\s*\((.*)\)\s*$", re.IGNORECASE)
SUBTOTAL_RE = re.compile(r"^\s*=\s*SUBTOTAL\s*\(\s*(?:9|109)\s*[,;]\s*(.*)\)\s*$", re.IGNORECASE)
ENGINE_LOCK = threading.Lock()


def finite_number(value: Any) -> float | int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(float(value)) else None


def strict_b64(value: Any) -> bytes:
    if not isinstance(value, str) or not value:
        raise ValueError("artifactBase64 must be a non-empty string")
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("artifactBase64 is invalid") from error


def validate_binding(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"artifactDigest", "policyVersion", "evaluator", "checks"}:
        raise ValueError("binding shape is invalid")
    digest = value["artifactDigest"]
    policy = value["policyVersion"]
    evaluator = value["evaluator"]
    checks = value["checks"]
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("artifactDigest must be lowercase SHA-256 hex")
    if not isinstance(policy, str) or not policy:
        raise ValueError("policyVersion is invalid")
    if (
        not isinstance(evaluator, dict)
        or set(evaluator) != {"id", "revision", "buildDigest", "contractVersion", "configurationDigest"}
        or not isinstance(evaluator.get("id"), str)
        or not evaluator["id"]
        or not isinstance(evaluator.get("revision"), str)
        or not evaluator["revision"]
        or evaluator.get("contractVersion") != "finny.spreadsheet-worker.v2"
        or not isinstance(evaluator.get("buildDigest"), str)
        or not re.fullmatch(r"[0-9a-f]{64}", evaluator["buildDigest"])
        or not isinstance(evaluator.get("configurationDigest"), str)
        or not re.fullmatch(r"[0-9a-f]{64}", evaluator["configurationDigest"])
    ):
        raise ValueError("binding evaluator is invalid")
    if not isinstance(checks, list) or not checks:
        raise ValueError("checks are invalid")
    seen: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for check in checks:
        if not isinstance(check, dict) or set(check) != {"checkId", "generation"}:
            raise ValueError("check binding shape is invalid")
        check_id = check["checkId"]
        generation = check["generation"]
        if check_id not in CHECKS or check_id in seen:
            raise ValueError("check binding contains an unknown or duplicate check")
        if isinstance(generation, bool) or not isinstance(generation, int) or generation < 1:
            raise ValueError("check generation is invalid")
        seen.add(check_id)
        normalized.append({"checkId": check_id, "generation": generation})
    return {"artifactDigest": digest, "policyVersion": policy, "evaluator": evaluator, "checks": normalized}


def formula_cells(workbook: Any) -> Iterable[tuple[str, str, str]]:
    for sheet in workbook.worksheets:
        for row in sheet.iter_rows():
            for cell in row:
                if cell.data_type == "f" or (isinstance(cell.value, str) and cell.value.startswith("=")):
                    yield sheet.title, cell.coordinate, str(cell.value)


def split_references(raw: str) -> list[str]:
    # Strict local staging engine: support straightforward SUM/SUBTOTAL lists.
    # Quoted sheet names may contain spaces, but not commas or semicolons.
    return [part.strip() for part in re.split(r"[,;]", raw) if part.strip()]


def resolve_reference(current_sheet: str, reference: str) -> tuple[str, str]:
    if "!" not in reference:
        return current_sheet, reference.replace("$", "")
    sheet_name, cell_range = reference.rsplit("!", 1)
    sheet_name = sheet_name.strip()
    if sheet_name.startswith("'") and sheet_name.endswith("'"):
        sheet_name = sheet_name[1:-1].replace("''", "'")
    return sheet_name, cell_range.replace("$", "")


def sum_reference_values(values_workbook: Any, current_sheet: str, raw: str, target: str) -> float | None:
    total = 0.0
    observed = 0
    for reference in split_references(raw):
        sign = 1.0
        if reference.startswith(("+", "-")):
            if reference[0] == "-":
                sign = -1.0
            reference = reference[1:].strip()
            if not reference:
                return None
        sheet_name, cell_range = resolve_reference(current_sheet, reference)
        if sheet_name not in values_workbook.sheetnames:
            return None
        try:
            min_col, min_row, max_col, max_row = range_boundaries(cell_range)
        except ValueError:
            return None
        sheet = values_workbook[sheet_name]
        for row in sheet.iter_rows(min_row=min_row, max_row=max_row, min_col=min_col, max_col=max_col):
            for cell in row:
                if sheet_name == current_sheet and cell.coordinate == target:
                    return None
                number = finite_number(cell.value)
                if number is not None:
                    total += sign * float(number)
                    observed += 1
                elif cell.value not in (None, ""):
                    return None
    return total if observed else None


def workbook_results(recalculated_path: Path, binding: dict[str, Any]) -> list[dict[str, Any]]:
    formulas_book = load_workbook(recalculated_path, data_only=False, read_only=False)
    values_book = load_workbook(recalculated_path, data_only=True, read_only=False)
    try:
        formulas = list(formula_cells(formulas_book))
        formula_evidence: list[dict[str, Any]] = []
        formula_error = False
        crossfoot_evidence: list[dict[str, Any]] = []
        crossfoot_error = False

        for sheet_name, coordinate, formula in formulas:
            calculated = values_book[sheet_name][coordinate].value
            number = finite_number(calculated)
            if number is not None:
                formula_evidence.append(
                    {
                        "sheet": sheet_name,
                        "cell": coordinate,
                        "formula": formula,
                        "calculatedValue": number,
                    }
                )
            elif isinstance(calculated, str) and calculated.startswith(FORMULA_ERROR_PREFIX):
                formula_error = True

            match = SUM_RE.match(formula) or SUBTOTAL_RE.match(formula)
            if not match:
                continue
            expected = sum_reference_values(values_book, sheet_name, match.group(1), coordinate)
            actual = finite_number(calculated)
            if expected is None or actual is None:
                crossfoot_error = True
                continue
            difference = float(actual) - expected
            crossfoot_evidence.append(
                {
                    "sheet": sheet_name,
                    "reference": coordinate,
                    "expected": expected,
                    "actual": actual,
                    "difference": difference,
                }
            )
            tolerance = max(1e-7, abs(expected) * 1e-9)
            if abs(difference) > tolerance:
                crossfoot_error = True

        sheets: list[dict[str, Any]] = []
        structure_error = not formulas_book.worksheets
        for sheet in formulas_book.worksheets:
            formula_count = sum(1 for _, _, _ in formula_cells_for_sheet(sheet))
            rows = sheet.max_row if sheet.max_row and sheet.max_column else 0
            columns = sheet.max_column if sheet.max_row and sheet.max_column else 0
            if rows < 1 or columns < 1:
                structure_error = True
            sheets.append(
                {
                    "name": sheet.title,
                    "rows": rows,
                    "columns": columns,
                    "formulas": formula_count,
                }
            )

        formula_verdict = "block" if formula_error or not formula_evidence else "pass"
        formula_references = [
            f"{sheet_name}!{coordinate}"
            for sheet_name, coordinate, _formula in formulas
            if finite_number(values_book[sheet_name][coordinate].value) is None
        ]
        if not formula_references and not formula_evidence:
            formula_references = ["workbook:no-formula-evidence"]
        crossfoot_mismatches = [
            f"{comparison['sheet']}!{comparison['reference']}"
            for comparison in crossfoot_evidence
            if comparison["difference"] != 0
        ]
        if crossfoot_error:
            crossfoot_verdict = "error"
            crossfoot_reason = {
                "code": "CROSSFOOT_EVALUATION_ERROR",
                "references": crossfoot_mismatches or ["workbook:unsupported-crossfoot-reference"],
            }
        elif not crossfoot_evidence or crossfoot_mismatches:
            crossfoot_verdict = "block"
            crossfoot_reason = {
                "code": "CROSSFOOT_MISMATCH",
                "references": crossfoot_mismatches or ["workbook:no-crossfoot-evidence"],
            }
        else:
            crossfoot_verdict = "pass"
            crossfoot_reason = None
        evidence = {
            "formula.recalculate": {
                "verdict": formula_verdict,
                "reason": None
                if formula_verdict == "pass"
                else {"code": "FORMULA_MISMATCH", "references": formula_references},
                "evidence": {"kind": "formula-recalculation", "cells": formula_evidence},
            },
            "summary.crossfoot": {
                "verdict": crossfoot_verdict,
                "reason": crossfoot_reason,
                "evidence": {"kind": "cross-foot", "comparisons": crossfoot_evidence},
            },
            "artifact.structure": {
                "verdict": "block" if structure_error else "pass",
                "reason": {"code": "STRUCTURE_INVALID", "references": ["workbook:structure"]}
                if structure_error
                else None,
                "evidence": {"kind": "structure", "sheets": sheets},
            },
        }
        return [
            {
                "checkId": check["checkId"],
                "generation": check["generation"],
                "verdict": evidence[check["checkId"]]["verdict"],
                "reason": evidence[check["checkId"]]["reason"],
                "evidence": evidence[check["checkId"]]["evidence"],
            }
            for check in binding["checks"]
        ]
    finally:
        formulas_book.close()
        values_book.close()


def formula_cells_for_sheet(sheet: Any) -> Iterable[tuple[str, str, str]]:
    for row in sheet.iter_rows():
        for cell in row:
            if cell.data_type == "f" or (isinstance(cell.value, str) and cell.value.startswith("=")):
                yield sheet.title, cell.coordinate, str(cell.value)


def recalculate_with_libreoffice(artifact: bytes, soffice: str, timeout_seconds: int) -> tuple[Path, tempfile.TemporaryDirectory[str]]:
    temp = tempfile.TemporaryDirectory(prefix="finny-engine-")
    root = Path(temp.name)
    source_dir = root / "source"
    output_dir = root / "output"
    profile_dir = root / "lo-profile"
    source_dir.mkdir()
    output_dir.mkdir()
    profile_dir.mkdir()
    source = source_dir / "artifact.xlsx"
    source.write_bytes(artifact)
    profile_uri = profile_dir.resolve().as_uri()
    command = [
        soffice,
        "--headless",
        "--nologo",
        "--nodefault",
        "--nofirststartwizard",
        "--nolockcheck",
        f"-env:UserInstallation={profile_uri}",
        "--convert-to",
        "xlsx",
        "--outdir",
        str(output_dir),
        str(source),
    ]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=timeout_seconds, check=False)
    except subprocess.TimeoutExpired as error:
        temp.cleanup()
        raise ValueError("LibreOffice recalculation timed out") from error
    output = output_dir / "artifact.xlsx"
    if completed.returncode != 0 or not output.is_file() or output.stat().st_size == 0:
        detail = (completed.stderr or completed.stdout or "unknown LibreOffice error").strip()[-500:]
        temp.cleanup()
        raise ValueError(f"LibreOffice recalculation failed: {detail}")
    return output, temp


def evaluate(payload: Any, *, soffice: str, max_artifact_bytes: int, timeout_seconds: int) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) != {"artifactBase64", "binding"}:
        raise ValueError("request shape is invalid")
    artifact = strict_b64(payload["artifactBase64"])
    if len(artifact) > max_artifact_bytes:
        raise ValueError("artifact exceeds the configured byte limit")
    if not artifact.startswith(b"PK"):
        raise ValueError("artifact is not an OOXML workbook")
    binding = validate_binding(payload["binding"])
    if hashlib.sha256(artifact).hexdigest() != binding["artifactDigest"]:
        raise ValueError("artifact digest does not match binding")
    with ENGINE_LOCK:
        recalculated, temp = recalculate_with_libreoffice(artifact, soffice, timeout_seconds)
        try:
            return {"results": workbook_results(recalculated, binding)}
        finally:
            temp.cleanup()


class EngineServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, server_address: tuple[str, int], handler: type[BaseHTTPRequestHandler], args: argparse.Namespace):
        super().__init__(server_address, handler)
        self.engine_args = args


class Handler(BaseHTTPRequestHandler):
    server_version = "FinnyLocalEngine/1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}")

    def send_json(self, status: int, body: dict[str, Any]) -> None:
        encoded = json.dumps(body, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        if self.path != "/healthz":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        self.send_json(HTTPStatus.OK, {"ok": True, "engine": "libreoffice-local", "version": "1"})

    def do_POST(self) -> None:
        if self.path != "/evaluate":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        args = self.server.engine_args  # type: ignore[attr-defined]
        content_type = self.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            self.send_json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "application_json_required"})
            return
        raw_length = self.headers.get("content-length")
        if raw_length is None or not raw_length.isdigit():
            self.send_json(HTTPStatus.LENGTH_REQUIRED, {"error": "content_length_required"})
            return
        length = int(raw_length)
        if length < 1 or length > args.max_request_bytes:
            self.send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "request_too_large"})
            return
        try:
            payload = json.loads(self.rfile.read(length))
            result = evaluate(
                payload,
                soffice=args.soffice,
                max_artifact_bytes=args.max_artifact_bytes,
                timeout_seconds=args.libreoffice_timeout,
            )
            self.send_json(HTTPStatus.OK, result)
        except (json.JSONDecodeError, ValueError) as error:
            self.send_json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": "evaluation_failed", "message": str(error)})
        except Exception:
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "internal_error"})


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8443)
    parser.add_argument("--cert", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--soffice", default="/Applications/LibreOffice.app/Contents/MacOS/soffice")
    parser.add_argument("--max-artifact-bytes", type=int, default=50 * 1024 * 1024)
    parser.add_argument("--max-request-bytes", type=int, default=70 * 1024 * 1024)
    parser.add_argument("--libreoffice-timeout", type=int, default=90)
    args = parser.parse_args()
    if args.host not in {"127.0.0.1", "::1", "localhost"}:
        parser.error("local staging engine must bind to loopback")
    if args.port < 1 or args.port > 65535:
        parser.error("invalid port")
    if args.max_artifact_bytes < 1 or args.max_request_bytes < args.max_artifact_bytes:
        parser.error("invalid byte limits")
    return args


def main() -> None:
    args = parse_args()
    if not Path(args.cert).is_file() or not Path(args.key).is_file():
        raise SystemExit("TLS certificate or key is missing")
    if not Path(args.soffice).is_file():
        raise SystemExit(f"LibreOffice executable is missing: {args.soffice}")
    server = EngineServer((args.host, args.port), Handler, args)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(args.cert, args.key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    print(f"Finny local engine listening on https://{args.host}:{args.port}/evaluate", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
