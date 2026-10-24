#!/bin/sh
# Refuses a registry or package-index URL that could carry credentials before the image writes it into npm or pip
# configuration that every sandbox workload can read (the value is also a build argument, recorded in the image
# history). User info (user:password@ or token@), extra slashes before the host (which hide user info from this
# check but not from URL parsers), query strings, fragments, and spaces, backslashes, or control characters (a line
# break, or an escape some shells' echo expands, would add its own configuration line, such as an _authToken) are
# refused; the value is never printed. Authenticated registries need their own mechanism (build secrets, vaults),
# which is not available yet.
#
#   check-registry-url.sh <setting name> <url>      (an empty url passes: the setting is optional)
set -eu
name="$1"
value="${2-}"
[ -n "$value" ] || exit 0
case "$value" in
  *[[:space:][:cntrl:]]* | *'\'*) echo "$name must be a single URL without spaces, line breaks, backslashes, or control characters." >&2; exit 1 ;;
esac
case "$value" in
  [Hh][Tt][Tt][Pp]://* | [Hh][Tt][Tt][Pp][Ss]://*) ;;
  *) echo "$name must be an http(s) URL." >&2; exit 1 ;;
esac
rest="${value#*://}"
# URL parsers (and so npm and pip) skip extra slashes after the scheme and read what follows as the authority, so
# https:///user:token@host/ carries credentials that an empty authority here would hide.
case "$rest" in
  '' | /*) echo "$name must name the registry host right after the scheme (https://host/...), without extra slashes." >&2; exit 1 ;;
esac
authority="${rest%%/*}"
case "$authority" in
  *@*) echo "$name must not contain credentials (user:password@ or token@). Use a registry URL without credentials; authenticated registries are not supported in sandbox images yet." >&2; exit 1 ;;
esac
case "$rest" in
  *'?'* | *'#'*) echo "$name must not have a query string or fragment, which can carry credentials; use the registry's plain URL." >&2; exit 1 ;;
esac
