import argparse
import csv
import json
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path


def load(path, key_name, amount_name):
    rows = {}
    with Path(path).open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames or key_name not in reader.fieldnames or amount_name not in reader.fieldnames:
            raise ValueError(f"{path}: required columns are {key_name!r} and {amount_name!r}")
        for line, row in enumerate(reader, 2):
            key = row[key_name].strip()
            if not key:
                raise ValueError(f"{path}:{line}: blank key")
            if key in rows:
                raise ValueError(f"{path}:{line}: duplicate key {key!r}")
            try:
                amount = Decimal(row[amount_name].strip())
            except InvalidOperation as error:
                raise ValueError(f"{path}:{line}: invalid decimal amount") from error
            if not amount.is_finite():
                raise ValueError(f"{path}:{line}: non-finite amount")
            rows[key] = amount
    return rows


def reconcile(left, right, tolerance):
    output = []
    for key in sorted(set(left) | set(right)):
        left_amount = left.get(key)
        right_amount = right.get(key)
        if left_amount is None:
            bucket = "right_only"
            difference = -right_amount
        elif right_amount is None:
            bucket = "left_only"
            difference = left_amount
        else:
            difference = left_amount - right_amount
            bucket = "matched" if abs(difference) <= tolerance else "amount_break"
        output.append({
            "key": key,
            "left": str(left_amount) if left_amount is not None else None,
            "right": str(right_amount) if right_amount is not None else None,
            "difference": str(difference),
            "bucket": bucket,
        })
    return output


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--left", required=True)
    parser.add_argument("--right", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--amount", required=True)
    parser.add_argument("--tolerance", required=True)
    args = parser.parse_args()
    try:
        tolerance = Decimal(args.tolerance)
        if not tolerance.is_finite() or tolerance < 0:
            raise ValueError("tolerance must be a finite non-negative decimal")
        left = load(args.left, args.key, args.amount)
        right = load(args.right, args.key, args.amount)
        rows = reconcile(left, right, tolerance)
        result = {
            "left_total": str(sum(left.values(), Decimal("0"))),
            "right_total": str(sum(right.values(), Decimal("0"))),
            "difference": str(sum(left.values(), Decimal("0")) - sum(right.values(), Decimal("0"))),
            "counts": {bucket: sum(row["bucket"] == bucket for row in rows) for bucket in ("matched", "amount_break", "left_only", "right_only")},
            "rows": rows,
        }
        print(json.dumps(result, indent=2))
        return 0 if all(row["bucket"] == "matched" for row in rows) else 4
    except (OSError, ValueError, InvalidOperation) as error:
        print(str(error), file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
