#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
build="$root/build/native"
vendor="$root/vendor/box2d-2.3.1"
mkdir -p "$build"

mapfile -t sources < <(find "$vendor" -name '*.cpp' -print | sort)

clang++ \
    -std=c++20 \
    -O2 \
    -DNDEBUG \
    -ffp-contract=off \
    -fno-fast-math \
    -fno-strict-aliasing \
    -I"$root/tests/generated" \
    -I"$root/vendor" \
    -I"$root/src" \
    "$root/src/runtime_simulator.cpp" \
    "$root/src/level1_reference_model.cpp" \
    "$root/src/level1_simulator.cpp" \
    "$root/src/level1_reference_test.cpp" \
    "${sources[@]}" \
    -o "$build/level1_reference_test"

printf '%s\n' "$build/level1_reference_test"
