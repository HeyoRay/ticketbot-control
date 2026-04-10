#!/bin/bash
# Launch a minimal Chrome instance with only the ticket-bot extension
google-chrome \
  --user-data-dir=/home/raymond/.config/chrome-ticket-only \
  --no-first-run \
  --disable-sync \
  --load-extension=/home/raymond/projects/ticket-bot \
  --disable-default-apps \
  --no-default-browser-check &>/dev/null & disown
echo "Ticket Chrome launched (PID: $!)"
