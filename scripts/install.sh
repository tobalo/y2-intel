#!/bin/sh

set -eu

repository="${Y2_RELEASE_REPOSITORY:-tobalo/y2-intel}"
install_dir="${Y2_INSTALL_DIR:-${HOME}/.y2/bin}"
requested_version="${1:-latest}"

need_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "y2 installer requires $1" >&2
        exit 1
    fi
}

need_command curl
need_command tar
need_command uname

case "$(uname -s)" in
    Darwin) platform="macos" ;;
    Linux) platform="linux" ;;
    *)
        echo "y2 does not publish a binary for $(uname -s)" >&2
        exit 1
        ;;
esac

case "$(uname -m)" in
    x86_64|amd64) architecture="x86_64" ;;
    arm64|aarch64) architecture="aarch64" ;;
    *)
        echo "y2 does not publish a binary for $(uname -m)" >&2
        exit 1
        ;;
esac

if [ "$requested_version" = "latest" ]; then
    release_url="https://github.com/${repository}/releases/latest"
    effective_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "$release_url")"
    version="${effective_url##*/}"
else
    version="$requested_version"
fi

case "$version" in
    v[0-9]*.[0-9]*.[0-9]*) ;;
    *)
        echo "invalid y2 release version: $version" >&2
        exit 1
        ;;
esac

archive="y2-${platform}-${architecture}.tar.gz"
release_base="${Y2_RELEASE_BASE_URL:-https://github.com/${repository}/releases/download/${version}}"
temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/y2-install.XXXXXX")"

cleanup() {
    rm -rf "$temporary_dir"
}
trap cleanup EXIT HUP INT TERM

curl -fsSL "${release_base}/${archive}" -o "${temporary_dir}/${archive}"
curl -fsSL "${release_base}/${archive}.sha256" -o "${temporary_dir}/${archive}.sha256"

if command -v sha256sum >/dev/null 2>&1; then
    (cd "$temporary_dir" && sha256sum -c "${archive}.sha256")
elif command -v shasum >/dev/null 2>&1; then
    expected="$(awk '{print $1}' "${temporary_dir}/${archive}.sha256")"
    actual="$(shasum -a 256 "${temporary_dir}/${archive}" | awk '{print $1}')"
    if [ "$expected" != "$actual" ]; then
        echo "y2 archive checksum verification failed" >&2
        exit 1
    fi
else
    echo "y2 installer requires sha256sum or shasum" >&2
    exit 1
fi

tar -xzf "${temporary_dir}/${archive}" -C "$temporary_dir"
if [ ! -x "${temporary_dir}/y2" ]; then
    echo "y2 release archive did not contain an executable" >&2
    exit 1
fi

mkdir -p "$install_dir"
install "${temporary_dir}/y2" "${install_dir}/y2"

echo "Installed y2 ${version} to ${install_dir}/y2"
case ":${PATH}:" in
    *":${install_dir}:"*) ;;
    *) echo "Add ${install_dir} to PATH to run y2 from any directory." ;;
esac
