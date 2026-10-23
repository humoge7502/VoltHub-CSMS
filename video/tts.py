#!/usr/bin/env python3
"""Narration synthesis for the VoltHub demo video.

edge-tts (Microsoft neural voices) writes one mp3 per segment; ffprobe supplies the
duration that the recorder uses to size the video for that segment. Everything is
cached by a hash of (text, voice, rate) so re-running the build does not re-synthesise
— and a re-record after an edit only pays for the segment that changed.
"""
import hashlib
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "out", "audio")
os.makedirs(OUT, exist_ok=True)

def duration(path):
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
        capture_output=True, text=True, check=True,
    )
    return float(r.stdout.strip())

def synth(seg):
    key = hashlib.sha256(f"{seg['text']}|{seg['voice']}|{seg.get('rate','')}".encode()).hexdigest()[:12]
    mp3 = os.path.join(OUT, f"{seg['id']}-{key}.mp3")
    if not os.path.exists(mp3):
        cmd = [sys.executable, "-m", "edge_tts", "--voice", seg["voice"], "--text", seg["text"],
               "--write-media", mp3]
        if seg.get("rate"):
            cmd += [f"--rate={seg['rate']}"]
        subprocess.run(cmd, check=True, capture_output=True)
    return mp3, duration(mp3)

def main():
    with open(os.path.join(ROOT, "narration.json"), encoding="utf-8") as f:
        segs = json.load(f)
    out = []
    for s in segs:
        mp3, d = synth(s)
        out.append({"id": s["id"], "kind": s["kind"], "scene": s["scene"], "audio": mp3, "duration": round(d, 3),
                    "captions": s["captions"]})
        print(f"{s['id']:14s} {d:6.2f}s  {os.path.basename(mp3)}")
    with open(os.path.join(ROOT, "out", "timing.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
    print(f"\ntotal {sum(o['duration'] for o in out):.1f}s -> out/timing.json")

if __name__ == "__main__":
    main()
