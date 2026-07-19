#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
build="$root/build/wasm"
vendor="$root/vendor/box2d-2.3.1"
toolchain_root="${CIRCLOO_WASI_ROOT:-/tmp/circloo-wasi-toolchain/root}"
sysroot="$toolchain_root/usr/share/wasi-sysroot"
resource="$toolchain_root/usr/lib/clang/22"
output="$build/circloo-sim.wasm"
public_output="$root/../../static/game/circloo-sim.wasm"

if [[ ! -d "$sysroot" || ! -d "$resource" ]]; then
    printf 'Missing local WASI toolchain under %s\n' "$toolchain_root" >&2
    exit 1
fi

mkdir -p "$build"
mapfile -t sources < <(find "$vendor" -name '*.cpp' -print | sort)
mapfile -t abi_exports < <(
    grep -oE '^([[:alnum:]_:<>]+[[:space:]]+)+circloo_[A-Za-z0-9_]+' \
        "$root/src/level1_wasm.cpp" \
        | sed -E 's/.*(circloo_[A-Za-z0-9_]+)$/\1/' \
        | sort -u
)
export_flags=()
for symbol in "${abi_exports[@]}"; do
    export_flags+=("-Wl,--export=$symbol")
done

clang++ \
    --target=wasm32-wasip1 \
    --sysroot="$sysroot" \
    -resource-dir "$resource" \
    -std=c++20 \
    -O2 \
    -DNDEBUG \
    -DCIRCLOO_NO_LOG \
    -ffp-contract=off \
    -fno-fast-math \
    -fno-strict-aliasing \
    -fno-exceptions \
    -fno-rtti \
    -nostartfiles \
    -I"$root/tests/generated" \
    -I"$root/vendor" \
    -I"$root/src" \
    "$root/src/runtime_simulator.cpp" \
    "$root/src/level1_reference_model.cpp" \
    "$root/src/level1_simulator.cpp" \
    "$root/src/level1_wasm.cpp" \
    "${sources[@]}" \
    -Wl,--no-entry \
    -Wl,-z,stack-size=8388608 \
    -Wl,--initial-memory=33554432 \
    -Wl,--max-memory=67108864 \
    -Wl,--export-memory \
    "${export_flags[@]}" \
    -Wl,--strip-all \
    -o "$output"

cp "$output" "$public_output"
printf '%s\n' "$output"
