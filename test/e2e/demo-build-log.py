import sys
import time

# Deterministic, canned build log. No real projects, hosts or data are used.
LINES = [
    ("\x1b[1m>\x1b[0m \x1b[36mdemo-app\x1b[0m@\x1b[1m0.1.0\x1b[0m build",
     "\x1b[2mdemo-host\x1b[0m"),
    ("\x1b[2m────────────────────────────────────────────────────────\x1b[0m", ""),
]

STEPS = [
    ("\x1b[32m✓\x1b[0m resolved 412 packages in 0.8s", 0.35),
    ("\x1b[32m✓\x1b[0m built src/index.ts in 0.4s", 0.30),
    ("\x1b[32m✓\x1b[0m ran 128 unit tests in 1.9s", 0.55),
    ("\x1b[33m⚠\x1b[0m chunk exceeds recommended size (612 kB)", 0.45),
    ("\x1b[32m✓\x1b[0m 57 end-to-end tests passed in 12.4s", 0.70),
    ("\x1b[32m✓\x1b[0m typecheck clean, 0 errors", 0.35),
    ("\x1b[32m✓\x1b[0m lint clean, 0 errors", 0.30),
    ("\x1b[32m✓\x1b[0m coverage 98.3% lines", 0.50),
    ("\x1b[1;32m✓\x1b[0m build succeeded in 16.4s", 0.40),
]


def emit(text: str) -> None:
    sys.stdout.write(text + "\r\n")
    sys.stdout.flush()


def main() -> None:
    for line, sub in LINES:
        emit(f"{line}  {sub}".rstrip())

    for text, pause in STEPS:
        emit(text)
        time.sleep(pause)

    emit("")
    emit("\x1b[1;36m$\x1b[0m \x1b[2mwatch mode active — waiting for changes\x1b[0m")
    emit("")
    time.sleep(3600)


main()
