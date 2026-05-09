#!/bin/bash
# Simple HTTP server using netcat to serve metrics JSON on localhost:9100
while true; do
  {
    echo -ne "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n"
    cat /tmp/rudder-metrics.json 2>/dev/null || echo '{}'
  } | nc -l -p 9100 -q 1 || sleep 1
done
