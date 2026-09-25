import sys
import time

# Deterministic, canned migration output. Synthetic only.
LINES = [
    "\x1b[1;35mmigrate\x1b[0m \x1b[2mv3.1.0\x1b[0m \x1b[2mapplying 4 steps\x1b[0m",
    "\x1b[2m────────────────────────────────────────────────────────\x1b[0m",
]

STEPS = [
    ("\x1b[2m[1/4]\x1b[0m add column \x1b[36maccount_status\x1b[0m", 0.40),
    ("\x1b[2m[2/4]\x1b[0m backfill \x1b[2m184,203\x1b[0m rows", 0.70),
    ("\x1b[2m[3/4]\x1b[0m add index \x1b[36midx_account_status\x1b[0m", 0.45),
    ("\x1b[2m[4/4]\x1b[0m drop legacy column \x1b[36mlegacy_state\x1b[0m", 0.55),
    ("\x1b[1;32m✓\x1b[0m migration complete in 2.1s", 0.40),
]


def emit(text: str) -> None:
    sys.stdout.write(text + "\r\n")
    sys.stdout.flush()


def main() -> None:
    for line in LINES:
        emit(line)

    for text, pause in STEPS:
        emit(text)
        time.sleep(pause)

    emit("")
    emit("\x1b[1;36m$\x1b[0m \x1b[2mschema is now at version 3\x1b[0m")
    time.sleep(3600)


main()
