#pragma once

#include "level1_frame300_fixture.h"
#include "level1_reference_model.h"
#include "runtime_simulator.h"

namespace circloo {

using Level1State = RuntimeState;

class Level1Simulator {
public:
    Level1Simulator();

    Level1Simulator(const Level1Simulator&) = delete;
    Level1Simulator& operator=(const Level1Simulator&) = delete;

    void Step(std::uint8_t input) { simulator_.Step(input); }

    [[nodiscard]] const Level1State& state() const { return simulator_.state(); }
    [[nodiscard]] b2Body& player() { return simulator_.player(); }
    [[nodiscard]] const b2Body& player() const { return simulator_.player(); }
    [[nodiscard]] b2World& world() { return simulator_.world(); }
    [[nodiscard]] const b2World& world() const { return simulator_.world(); }

private:
    RuntimeModel model_;
    RuntimeSimulator simulator_;
};

} // namespace circloo
