import sys
import time

# Deterministic, canned server log with a redrawn status table. Synthetic only.
BANNER = [
    "\x1b[1;35mdemo-api\x1b[0m \x1b[2mv2.4.0\x1b[0m \x1b[2m(listening on :4310)\x1b[0m",
    "\x1b[2m────────────────────────────────────────────────────────\x1b[0m",
]

REQUESTS = [
    ("\x1b[32m200\x1b[0m GET  /api/health          \x1b[2m2ms\x1b[0m"),
    ("\x1b[32m200\x1b[0m GET  /api/sessions        \x1b[2m14ms\x1b[0m"),
    ("\x1b[32m201\x1b[0m POST /api/sessions        \x1b[2m31ms\x1b[0m"),
    ("\x1b[33m304\x1b[0m GET  /api/cache           \x1b[2m1ms\x1b[0m"),
    ("\x1b[32m200\x1b[0m GET  /api/terminals       \x1b[2m8ms\x1b[0m"),
    ("\x1b[31m500\x1b[0m GET  /api/reports         \x1b[2m182ms\x1b[0m"),
    ("\x1b[32m200\x1b[0m GET  /api/health          \x1b[2m1ms\x1b[0m"),
    ("\x1b[32m200\x1b[0m GET  /api/sessions        \x1b[2m12ms\x1b[0m"),
]


def emit(text: str) -> None:
    sys.stdout.write(text + "\r\n")
    sys.stdout.flush()


def main() -> None:
    for line in BANNER:
        emit(line)

    for _ in range(2):
        for line in REQUESTS:
            emit(line)
            time.sleep(0.28)
        emit("")

    emit("\x1b[1;35mdemo-api\x1b[0m \x1b[2mv2.4.0\x1b[0m \x1b[2mlistening on :4310\x1b[0m")
    time.sleep(3600)


main()
