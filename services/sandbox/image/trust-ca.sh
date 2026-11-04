#!/bin/sh
# Trust hook for the egress proxy's CA. sandboxd runs the equivalent on every sandbox start before anything else;
# custom images can call this script (as root) to verify their trust stores honor the system bundle:
#   managed-copilot-trust-ca /path/to/ca.pem
set -eu
if [ "$(id -u)" != "0" ]; then
  echo "managed-copilot-trust-ca must run as root." >&2
  exit 1
fi
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "Usage: managed-copilot-trust-ca <ca-certificate.pem>" >&2
  exit 2
fi
install -m 0644 "$1" /usr/local/share/ca-certificates/managed-copilot-egress.crt
update-ca-certificates --fresh >/dev/null
echo "Trusted the egress CA. Node: NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/managed-copilot-egress.crt;" \
     "Python/curl/git: /etc/ssl/certs/ca-certificates.crt"
