#!/usr/bin/env python3
import argparse, io, os, sys

MAX_DIM = 128
MAX_BYTES = 128 * 1024
DIMS = (128, 96, 64, 48, 32, 24, 16)


def fit(w: int, h: int, dim: int) -> tuple[int, int]:
    if w <= dim and h <= dim:
        return w, h
    scale = dim / float(max(w, h))
    return max(1, round(w * scale)), max(1, round(h * scale))


def static_candidates(img):
    from PIL import Image
    img = img.convert("RGBA")
    for dim in DIMS:
        small = img.resize(fit(img.width, img.height, dim), Image.LANCZOS)
        yield small
        yield small.quantize(colors=64, method=Image.FASTOCTREE, dither=Image.NONE)


def encode_static(im) -> bytes:
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def gif_candidates(img):
    from PIL import Image
    n = img.n_frames
    plan = [(dim, step) for dim in DIMS for step in (1, 2, 4) if step == 1 or n // step >= 2]
    for dim, step in plan + [(DIMS[-1], max(1, n // 2))]:
        frames, durations = [], []
        size = fit(img.width, img.height, dim)
        for i in range(0, n, step):
            img.seek(i)
            frames.append(img.convert("RGBA").resize(size, Image.LANCZOS).convert("P", palette=Image.ADAPTIVE))
            durations.append(img.info.get("duration", 100) * step)
        buf = io.BytesIO()
        frames[0].save(buf, format="GIF", save_all=True, append_images=frames[1:],
                       duration=durations, loop=img.info.get("loop", 0), disposal=2, optimize=True)
        yield buf.getvalue()


def normalize_image(src: str, dst: str) -> tuple[str, int]:
    from PIL import Image
    with Image.open(src) as img:
        animated = getattr(img, "is_animated", False) and getattr(img, "n_frames", 1) > 1
        mime = "image/gif" if animated else "image/png"
        candidates = gif_candidates(img) if animated else (encode_static(c) for c in static_candidates(img))
        best = None
        for data in candidates:
            if best is None or len(data) < len(best):
                best = data
            if len(data) <= MAX_BYTES:
                break
    with open(dst, "wb") as f:
        f.write(best)
    return mime, len(best)


def main() -> int:
    ap = argparse.ArgumentParser(description="Normalize an image to fit Slack's custom-emoji limits (128x128 px, 128 KB).")
    ap.add_argument("--file", required=True, help="input image (png/jpg/gif/webp)")
    ap.add_argument("--out", default="", help="output path (defaults to overwriting --file)")
    args = ap.parse_args()
    if not os.path.isfile(args.file):
        print(f"file not found: {args.file}", file=sys.stderr)
        return 1
    try:
        mime, size = normalize_image(args.file, args.out or args.file)
    except Exception as e:
        print(f"normalize failed: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    if size > MAX_BYTES:
        print(f"still {size} bytes after every pass; Slack allows {MAX_BYTES}", file=sys.stderr)
        return 1
    print(mime)
    return 0


if __name__ == "__main__":
    sys.exit(main())
