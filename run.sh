#!/bin/sh
# Build if needed, then run. Any arguments are passed through to the server,
# e.g.  ./run.sh --osc-host 192.168.1.50 --osc-port 9000
set -e
cd "$(dirname "$0")"
[ -f target/solarsystem.jar ] || { echo "Building..."; mvn -q package; }
exec java -jar target/solarsystem.jar "$@"
