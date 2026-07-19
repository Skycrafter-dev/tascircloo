#!/usr/bin/env python3
"""Generate the Level 1 C++ parity fixture from captured GameMaker state."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Iterable


def cpp_number(value: Any) -> str:
    number = float(value)
    if number == 0.0:
        return "0.0"
    return format(number, ".17g")


def cpp_bool(value: Any) -> str:
    return "true" if bool(value) else "false"


def shape_from_fixture(fixture: dict[str, Any]) -> dict[str, Any]:
    shape = fixture.get("shape")
    if not isinstance(shape, dict):
        raise ValueError("fixture is missing its exact shape export")
    return shape


def fixture_filter(fixture: dict[str, Any]) -> dict[str, Any]:
    value = fixture.get("filter")
    if not isinstance(value, dict):
        raise ValueError("fixture is missing its exact filter export")
    return value


def input_bits(value: str) -> int:
    bits = 0
    if "L" in value:
        bits |= 1
    if "R" in value:
        bits |= 2
    return bits


def emit_array(name: str, ctype: str, rows: Iterable[str], count: int) -> str:
    body = ",\n".join(f"\t{row}" for row in rows)
    return f"inline constexpr std::array<{ctype}, {count}> {name} = {{{{\n{body}\n}}}};\n"


def chain_rows_from_boundary(state: dict[str, Any]) -> list[str]:
    vertices = state.get("vertices")
    if not isinstance(vertices, list) or len(vertices) < 4:
        raise ValueError("boundary state is missing its exact chain vertices")
    if vertices[-1] != vertices[0]:
        raise ValueError("boundary chain does not contain the Box2D loop duplicate")
    # The runtime export contains the duplicate appended by Box2D CreateLoop.
    # Feed the preceding 201 entries back to CreateLoop, including the duplicate
    # endpoint that GameMaker originally supplied.
    return [
        f"Vec2{{{cpp_number(vertex['x'])}, {cpp_number(vertex['y'])}}}"
        for vertex in vertices[:-1]
    ]


def static_circle_row(circle: dict[str, Any]) -> str:
    filter_data = circle["filter"]
    return "StaticCircle{" + ", ".join(
        [
            str(int(circle["id"])),
            cpp_number(circle["position"]["x"]),
            cpp_number(circle["position"]["y"]),
            cpp_number(circle["radius"]),
            cpp_number(circle["friction"]),
            cpp_number(circle["restitution"]),
            str(int(filter_data["categoryBits"])),
            str(int(filter_data["maskBits"])),
            str(int(filter_data["groupIndex"])),
        ]
    ) + "}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--trace", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    model = json.loads(args.model.read_text())
    trace_root = json.loads(args.trace.read_text())
    frames = trace_root["frames"]
    boundary_states = trace_root.get("boundaryStates")
    if not isinstance(boundary_states, list):
        raise ValueError("trace is missing exact boundaryStates exports")
    boundary_by_radius = {int(state["radius"]): state for state in boundary_states}
    if sorted(boundary_by_radius) != [1000, 1200, 1400]:
        raise ValueError(f"unexpected Level 1 boundary states: {sorted(boundary_by_radius)!r}")
    bodies = model["bodies"]

    chain_body = next(body for body in bodies if body["objectIndex"] == 1)
    player_body = next(body for body in bodies if body["objectIndex"] == 20)
    static_bodies = [body for body in reversed(bodies) if body["objectIndex"] == 45]

    chain_fixture = chain_body["fixtures"][0]
    chain_shape = shape_from_fixture(chain_fixture)
    chain_vertices = chain_shape["vertices"]
    if len(chain_vertices) < 4 or chain_vertices[-1] != chain_vertices[0]:
        raise ValueError("captured chain does not contain the Box2D loop duplicate")
    # GameMaker passed one duplicate endpoint to CreateLoop. Box2D then appended
    # the first vertex once more, producing the captured 202-entry chain.
    chain_input_vertices = chain_vertices[:-1]

    player_fixture = player_body["fixtures"][0]
    player_shape = shape_from_fixture(player_fixture)
    player_filter = fixture_filter(player_fixture)
    chain_filter = fixture_filter(chain_fixture)

    static_rows: list[str] = []
    for body in static_bodies:
        fixture = body["fixtures"][0]
        shape = shape_from_fixture(fixture)
        filter_data = fixture_filter(fixture)
        static_rows.append(
            "StaticCircle{" + ", ".join(
                [
                    str(int(body["userId"])),
                    cpp_number(body["position"]["x"]),
                    cpp_number(body["position"]["y"]),
                    cpp_number(shape["radius"]),
                    cpp_number(fixture["friction"]),
                    cpp_number(fixture["restitution"]),
                    str(int(filter_data["categoryBits"])),
                    str(int(filter_data["maskBits"])),
                    str(int(filter_data["groupIndex"])),
                ]
            ) + "}"
        )

    radius_values = sorted({float(frame["bigRadius"]) for frame in frames})
    if radius_values != [1000.0, 1200.0, 1400.0]:
        raise ValueError(f"unexpected Level 1 boundary radii: {radius_values!r}")

    vertex_rows = chain_rows_from_boundary(boundary_by_radius[1000])
    vertex_rows_1200 = chain_rows_from_boundary(boundary_by_radius[1200])
    vertex_rows_1400 = chain_rows_from_boundary(boundary_by_radius[1400])

    initial_static_ids = {
        int(circle["id"]) for circle in boundary_by_radius[1000]["staticCircles"]
    }
    growth_static_circles = [
        circle
        for circle in boundary_by_radius[1200]["staticCircles"]
        if int(circle["id"]) not in initial_static_ids
    ]
    growth_static_rows = [static_circle_row(circle) for circle in growth_static_circles]

    reference_rows = []
    input_rows = []
    for frame_index, frame in enumerate(frames):
        reference_rows.append(
            "ReferenceFrame{" + ", ".join(
                [
                    str(int(frame["frame"])),
                    str(int(frame["cp"])),
                    cpp_number(frame["position"]["x"]),
                    cpp_number(frame["position"]["y"]),
                    cpp_number(frame["linearVelocity"]["x"]),
                    cpp_number(frame["linearVelocity"]["y"]),
                    cpp_number(frame["angle"]),
                    cpp_number(frame["angularVelocity"]),
                    cpp_number(frame["bigRadius"]),
                    str(int(frame["alarm"])),
                ]
            ) + "}"
        )
        destination_frame = frames[min(frame_index + 1, len(frames) - 1)]
        input_rows.append(str(input_bits(destination_frame["input"])))

    collectible_rows = [
        "Collectible{" + ", ".join(
            [
                str(int(item["id"])),
                cpp_number(item["x"]),
                cpp_number(item["y"]),
            ]
        ) + "}"
        for item in model["collectibles"]
        if item["active"] and not item["collected"] and not item["excluded"]
    ]

    source = f"""// Generated by tools/generate_level1_fixture.py. Do not edit.
#pragma once

#include <array>
#include <cstdint>

namespace circloo::fixture {{

struct Vec2 {{ double x; double y; }};
struct StaticCircle {{
    std::int32_t instance_id;
    double x;
    double y;
    double radius;
    double friction;
    double restitution;
    std::uint16_t category_bits;
    std::uint16_t mask_bits;
    std::int16_t group_index;
}};
struct Collectible {{ std::int32_t instance_id; double x_pixels; double y_pixels; }};
struct ReferenceFrame {{
    std::int32_t frame;
    std::int32_t checkpoint;
    double x;
    double y;
    double vx;
    double vy;
    double angle;
    double angular_velocity;
    double big_radius_pixels;
    std::int32_t growth_alarm;
}};

inline constexpr double kScale = {cpp_number(model['wrapper']['_sd1'])};
inline constexpr double kStepRate = {cpp_number(model['wrapper']['_K62'])};
inline constexpr std::int32_t kVelocityIterations = {int(model['wrapper']['_L62'])};
inline constexpr std::int32_t kPositionIterations = {int(model['wrapper']['_L62'])};
inline constexpr Vec2 kGravity{{{cpp_number(model['world']['_IE1']['x'])}, {cpp_number(model['world']['_IE1']['y'])}}};

inline constexpr Vec2 kPlayerPosition{{{cpp_number(player_body['position']['x'])}, {cpp_number(player_body['position']['y'])}}};
inline constexpr Vec2 kPlayerVelocity{{{cpp_number(player_body['linearVelocity']['x'])}, {cpp_number(player_body['linearVelocity']['y'])}}};
inline constexpr double kPlayerAngle = {cpp_number(player_body['angle'])};
inline constexpr double kPlayerAngularVelocity = {cpp_number(player_body['angularVelocity'])};
inline constexpr double kPlayerRadius = {cpp_number(player_shape['radius'])};
inline constexpr double kPlayerDensity = {cpp_number(player_fixture['density'])};
inline constexpr double kPlayerFriction = {cpp_number(player_fixture['friction'])};
inline constexpr double kPlayerRestitution = {cpp_number(player_fixture['restitution'])};
inline constexpr double kPlayerLinearDamping = {cpp_number(player_body['linearDamping'])};
inline constexpr double kPlayerAngularDamping = {cpp_number(player_body['angularDamping'])};
inline constexpr double kPlayerGravityScale = {cpp_number(player_body['gravityScale'])};
inline constexpr bool kPlayerAllowSleep = {cpp_bool(player_body['allowSleep'])};
inline constexpr bool kPlayerAwake = {cpp_bool(player_body['awake'])};
inline constexpr bool kPlayerActive = {cpp_bool(player_body['active'])};
inline constexpr bool kPlayerBullet = {cpp_bool(player_body['bullet'])};
inline constexpr bool kPlayerFixedRotation = {cpp_bool(player_body['fixedRotation'])};
inline constexpr std::uint16_t kPlayerCategoryBits = {int(player_filter['categoryBits'])};
inline constexpr std::uint16_t kPlayerMaskBits = {int(player_filter['maskBits'])};
inline constexpr std::int16_t kPlayerGroupIndex = {int(player_filter['groupIndex'])};

inline constexpr double kChainFriction = {cpp_number(chain_fixture['friction'])};
inline constexpr double kChainRestitution = {cpp_number(chain_fixture['restitution'])};
inline constexpr std::uint16_t kChainCategoryBits = {int(chain_filter['categoryBits'])};
inline constexpr std::uint16_t kChainMaskBits = {int(chain_filter['maskBits'])};
inline constexpr std::int16_t kChainGroupIndex = {int(chain_filter['groupIndex'])};

{emit_array('kChainVertices', 'Vec2', vertex_rows, len(vertex_rows))}
{emit_array('kChainVertices1200', 'Vec2', vertex_rows_1200, len(vertex_rows_1200))}
{emit_array('kChainVertices1400', 'Vec2', vertex_rows_1400, len(vertex_rows_1400))}
{emit_array('kStaticCircles', 'StaticCircle', static_rows, len(static_rows))}
{emit_array('kGrowthStaticCircles', 'StaticCircle', growth_static_rows, len(growth_static_rows))}
{emit_array('kCollectibles', 'Collectible', collectible_rows, len(collectible_rows))}
{emit_array('kReferenceFrames', 'ReferenceFrame', reference_rows, len(reference_rows))}
{emit_array('kInputBits', 'std::uint8_t', input_rows, len(input_rows))}

}} // namespace circloo::fixture
"""

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(source)


if __name__ == "__main__":
    main()
