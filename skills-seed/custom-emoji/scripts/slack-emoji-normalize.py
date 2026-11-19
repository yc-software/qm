#!/usr/bin/env python3
import argparse, io, os, sys


MAX_DIM = 128
MAX_BYTES = 128 * 1024


def log(*a) -> None:
    print("[slack-emoji-normalize]", *a, file=sys.stderr, flush=True)


def _is_animated_gif(img) -> bool:
    return getattr(img, "is_animated", False) and getattr(img, "n_frames", 1) > 1


def _scale_size(w: int, h: int, max_dim: int) -> tuple[int, int]:
    if w <= max_dim and h <= max_dim:
        return w, h
    scale = max_dim / float(max(w, h))
    return max(1, int(round(w * scale))), max(1, int(round(h * scale)))


def _normalize_static(img, max_dim: int, max_bytes: int) -> bytes:
    from PIL import Image
    img = img.convert("RGBA")
    w, h = _scale_size(img.width, img.height, max_dim)
    work = img.resize((w, h), Image.LANCZOS) if (w, h) != img.size else img

    def encode_png(im) -> bytes:
        buf = io.BytesIO()
        im.save(buf, format="PNG", optimize=True)
        return buf.getvalue()

    out = encode_png(work)
    if len(out) <= max_bytes:
        return out

    for colors in (256, 128, 64, 32, 16):
        q = work.quantize(colors=colors, method=Image.FASTOCTREE, dither=Image.NONE)
        cand = encode_png(q)
        if len(cand) <= max_bytes:
            return cand
        out = cand

    dim = max_dim
    while dim > 16:
        dim = max(16, int(dim * 0.8))
        sw, sh = _scale_size(img.width, img.height, dim)
        small = img.resize((sw, sh), Image.LANCZOS).quantize(colors=64, method=Image.FASTOCTREE, dither=Image.NONE)
        cand = encode_png(small)
        if len(cand) <= max_bytes:
            return cand
        out = cand
    return out


def _normalize_gif(img, max_dim: int, max_bytes: int) -> bytes:
    from PIL import Image
    n = img.n_frames

    def build(step: int, dim: int) -> bytes:
        frames, durations = [], []
        fw, fh = _scale_size(img.width, img.height, dim)
        for i in range(0, n, step):
            img.seek(i)
            frame = img.convert("RGBA").resize((fw, fh), Image.LANCZOS).convert("P", palette=Image.ADAPTIVE)
            frames.append(frame)
            durations.append(img.info.get("duration", 100))
        buf = io.BytesIO()
        loop = img.info.get("loop", 0)
        frames[0].save(buf, format="GIF", save_all=True, append_images=frames[1:],
                       duration=durations, loop=loop, disposal=2, optimize=True)
        return buf.getvalue()

    best = build(1, max_dim)
    if len(best) <= max_bytes:
        return best

    for dim in (max_dim, 96, 64, 48, 32):
        for step in (1, 2, 3, 4, 6, 8):
            if n // step < 2:
                break
            cand = build(step, dim)
            if len(cand) <= max_bytes:
                return cand
            if len(cand) < len(best):
                best = cand

    for dim in (32, 24, 16):
        cand = build(max(1, n // 2), dim)
        if len(cand) <= max_bytes:
            return cand
        if len(cand) < len(best):
            best = cand
    return best


def normalize_image(src_path: str, dst_path: str, max_dim: int = MAX_DIM, max_bytes: int = MAX_BYTES) -> str:
    from PIL import Image
    with Image.open(src_path) as img:
        if _is_animated_gif(img):
            data, mime = _normalize_gif(img, max_dim, max_bytes), "image/gif"
        else:
            data, mime = _normalize_static(img, max_dim, max_bytes), "image/png"
    with open(dst_path, "wb") as f:
        f.write(data)
    if len(data) > max_bytes:
        log("output still", len(data), "bytes >", max_bytes, "after all passes")
    return mime


def main() -> int:
    ap = argparse.ArgumentParser(description="Normalize an image to fit Slack's custom-emoji limits.")
    ap.add_argument("--file", required=True, help="input image (png/jpg/gif/webp)")
    ap.add_argument("--out", default="", help="output path (defaults to overwriting --file)")
    args = ap.parse_args()
    src = args.file
    if not os.path.isfile(src):
        log("file not found:", src)
        return 1
    dst = args.out or src
    try:
        mime = normalize_image(src, dst)
    except Exception as e:
        log("normalize failed:", type(e).__name__, e)
        return 1
    print(mime, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
