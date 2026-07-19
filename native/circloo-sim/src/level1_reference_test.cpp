#include "level1_simulator.h"

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>

namespace {

using circloo::fixture::ReferenceFrame;

std::uint64_t ordered_bits(double value) {
    std::uint64_t bits = std::bit_cast<std::uint64_t>(value);
    if ((bits >> 63U) != 0U) {
        return ~bits + 1U;
    }
    return bits | (std::uint64_t{1} << 63U);
}

std::uint64_t ulp_distance(double left, double right) {
    const auto a = ordered_bits(left);
    const auto b = ordered_bits(right);
    return a > b ? a - b : b - a;
}

struct ErrorSummary {
    double max_absolute = 0.0;
    std::uint64_t max_ulp = 0;
    const char* field = "";
};

void record_error(ErrorSummary& summary, const char* field, double actual, double expected) {
    const double absolute = std::abs(actual - expected);
    const std::uint64_t ulps = ulp_distance(actual, expected);
    if (absolute > summary.max_absolute) {
        summary.max_absolute = absolute;
        summary.field = field;
    }
    summary.max_ulp = std::max(summary.max_ulp, ulps);
}

bool compare_frame(
    const circloo::Level1Simulator& simulator,
    const ReferenceFrame& expected,
    ErrorSummary& summary
) {
    const b2Body& body = simulator.player();
    const b2Vec2 position = body.GetPosition();
    const b2Vec2 velocity = body.GetLinearVelocity();
    record_error(summary, "x", position.x, expected.x);
    record_error(summary, "y", position.y, expected.y);
    record_error(summary, "vx", velocity.x, expected.vx);
    record_error(summary, "vy", velocity.y, expected.vy);
    record_error(summary, "angle", body.GetAngle(), expected.angle);
    record_error(summary, "angular_velocity", body.GetAngularVelocity(), expected.angular_velocity);

    const auto& state = simulator.state();
    return position.x == expected.x && position.y == expected.y &&
        velocity.x == expected.vx && velocity.y == expected.vy &&
        body.GetAngle() == expected.angle &&
        body.GetAngularVelocity() == expected.angular_velocity &&
        state.frame == expected.frame &&
        state.checkpoint == expected.checkpoint &&
        state.boundary_radius_pixels == expected.big_radius_pixels &&
        state.growth_alarm == expected.growth_alarm;
}

void print_mismatch(const circloo::Level1Simulator& simulator, const ReferenceFrame& expected) {
    const b2Body& body = simulator.player();
    const b2Vec2 position = body.GetPosition();
    const b2Vec2 velocity = body.GetLinearVelocity();
    const auto& state = simulator.state();
    std::printf("first mismatch at frame %d\n", expected.frame);
    std::printf("  position actual=(%.17g, %.17g) expected=(%.17g, %.17g)\n",
        position.x, position.y, expected.x, expected.y);
    std::printf("  velocity actual=(%.17g, %.17g) expected=(%.17g, %.17g)\n",
        velocity.x, velocity.y, expected.vx, expected.vy);
    std::printf("  angle actual=%.17g expected=%.17g\n", body.GetAngle(), expected.angle);
    std::printf("  omega actual=%.17g expected=%.17g\n",
        body.GetAngularVelocity(), expected.angular_velocity);
    std::printf(
        "  lifecycle actual=(frame=%d cp=%d radius=%d alarm=%d) "
        "expected=(frame=%d cp=%d radius=%.0f alarm=%d)\n",
        state.frame,
        state.checkpoint,
        state.boundary_radius_pixels,
        state.growth_alarm,
        expected.frame,
        expected.checkpoint,
        expected.big_radius_pixels,
        expected.growth_alarm
    );
}

void log_contacts(const circloo::Level1Simulator& simulator) {
    const auto& state = simulator.state();
    const b2World& world = simulator.world();
    std::printf("frame=%d contacts=%d", state.frame, world.GetContactCount());
    for (const b2Contact* contact = world.GetContactList(); contact; contact = contact->GetNext()) {
        const auto* tag_a = static_cast<const circloo::InstanceTag*>(
            contact->GetFixtureA()->GetBody()->GetUserData()
        );
        const auto* tag_b = static_cast<const circloo::InstanceTag*>(
            contact->GetFixtureB()->GetBody()->GetUserData()
        );
        std::printf(" [a=%d:%d b=%d:%d touching=%d enabled=%d points=%d]",
            tag_a ? tag_a->id : -1,
            contact->GetChildIndexA(),
            tag_b ? tag_b->id : -1,
            contact->GetChildIndexB(),
            contact->IsTouching() ? 1 : 0,
            contact->IsEnabled() ? 1 : 0,
            contact->GetManifold()->pointCount);
    }
    std::printf("\n");
}

} // namespace

int main(int argc, char** argv) {
    int end_frame = 658;
    bool should_log_contacts = false;
    if (argc > 1) {
        end_frame = std::atoi(argv[1]);
    }
    if (argc > 2) {
        should_log_contacts = std::atoi(argv[2]) != 0;
    }

    circloo::Level1Simulator simulator;
    const double mass = simulator.player().GetMass();
    const double inertia = simulator.player().GetInertia();
    std::printf("player mass=%.17g inertia=%.17g contacts=%d\n",
        mass, inertia, simulator.world().GetContactCount());

    ErrorSummary summary;
    if (!compare_frame(simulator, circloo::fixture::kReferenceFrames[0], summary)) {
        print_mismatch(simulator, circloo::fixture::kReferenceFrames[0]);
        return 1;
    }

    for (std::size_t index = 0; index + 1 < circloo::fixture::kReferenceFrames.size(); ++index) {
        if (simulator.state().frame >= end_frame) {
            break;
        }

        simulator.Step(circloo::fixture::kInputBits[index]);
        const auto& expected = circloo::fixture::kReferenceFrames[index + 1];
        if (should_log_contacts && expected.frame >= 625 && expected.frame <= 636) {
            log_contacts(simulator);
        }
        if (!compare_frame(simulator, expected, summary)) {
            print_mismatch(simulator, expected);
            std::printf("  max absolute=%.17g field=%s max ulp=%llu\n",
                summary.max_absolute,
                summary.field,
                static_cast<unsigned long long>(summary.max_ulp));
            return 2;
        }
    }

    const auto& times = simulator.state().checkpoint_frames;
    std::printf(
        "checkpoint frames=[%d,%d,%d,%d,%d,%d,%d]\n",
        times[1], times[2], times[3], times[4], times[5], times[6], times[7]
    );
    std::printf("exact through frame %d; max absolute=%.17g max ulp=%llu\n",
        end_frame,
        summary.max_absolute,
        static_cast<unsigned long long>(summary.max_ulp));
    return 0;
}
