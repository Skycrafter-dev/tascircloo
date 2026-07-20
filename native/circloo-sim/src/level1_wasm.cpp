#include "level1_reference_model.h"
#include "level1_frame300_fixture.h"
#include "runtime_simulator.h"

#include <cstddef>
#include <cstdint>
#include <vector>

namespace {

constexpr std::uint32_t kInputCapacity = 8192;
constexpr std::uint32_t kVertexCapacity = 32768;
constexpr std::uint32_t kBodyStateCapacity = 4096;
constexpr std::uint32_t kJointStateCapacity = 4096;
constexpr std::int32_t kFramePatchTargetBase = -1000000000;

struct WasmResult {
    std::int32_t frame;
    std::int32_t checkpoint;
    std::int32_t growth_alarm;
    std::int32_t boundary_radius_pixels;
    std::int32_t checkpoint_frames[8];
    double x;
    double y;
    double vx;
    double vy;
    double angle;
    double angular_velocity;
};

struct WasmBodyState {
    std::int32_t instance_id;
    std::int32_t object_index;
    std::int32_t type;
    std::int32_t flags;
    double x;
    double y;
    double vx;
    double vy;
    double angle;
    double angular_velocity;
    double sleep_time;
    double mass;
    double inverse_mass;
    double inertia;
    double inverse_inertia;
    double local_center_x;
    double local_center_y;
};

struct WasmJointState {
    std::int32_t type;
    std::int32_t body_a_id;
    std::int32_t body_b_id;
    std::int32_t limit_state;
    double impulse_x;
    double impulse_y;
    double impulse_z;
    double motor_impulse;
};

struct BodyLocation {
    std::int32_t patch_index;
    std::uint32_t body_index;
};

static_assert(offsetof(WasmResult, checkpoint_frames) == 16);
static_assert(offsetof(WasmResult, x) == 48);
static_assert(sizeof(WasmResult) == 96);
static_assert(offsetof(WasmBodyState, x) == 16);
static_assert(sizeof(WasmBodyState) == 120);
static_assert(offsetof(WasmJointState, impulse_x) == 16);
static_assert(sizeof(WasmJointState) == 48);

alignas(16) std::uint8_t g_inputs[kInputCapacity]{};
alignas(16) circloo::ModelVec2 g_vertices[kVertexCapacity]{};
alignas(16) WasmResult g_result{};
alignas(16) WasmBodyState g_body_states[kBodyStateCapacity]{};
std::uint32_t g_body_state_count = 0;
alignas(16) WasmJointState g_joint_states[kJointStateCapacity]{};
std::uint32_t g_joint_state_count = 0;
circloo::RuntimeSimulator* g_sequence_simulator = nullptr;

circloo::RuntimeModel& LoadedModel() {
    static circloo::RuntimeModel model;
    return model;
}

std::vector<BodyLocation>& BodyLocations() {
    static std::vector<BodyLocation> locations;
    return locations;
}

bool& ModelReady() {
    static bool ready = false;
    return ready;
}

circloo::ModelBody* ResolveBody(std::int32_t handle) {
    auto& locations = BodyLocations();
    if (handle < 0 || static_cast<std::size_t>(handle) >= locations.size()) {
        return nullptr;
    }
    const BodyLocation location = locations[static_cast<std::size_t>(handle)];
    auto& model = LoadedModel();
    if (location.patch_index == -1) {
        if (location.body_index >= model.bodies.size()) {
            return nullptr;
        }
        return &model.bodies[location.body_index];
    }
    if (location.patch_index <= kFramePatchTargetBase) {
        const std::size_t frame_patch_index = static_cast<std::size_t>(
            kFramePatchTargetBase - location.patch_index
        );
        if (frame_patch_index >= model.frame_patches.size()) {
            return nullptr;
        }
        auto& bodies = model.frame_patches[frame_patch_index].spawned_bodies;
        if (location.body_index >= bodies.size()) {
            return nullptr;
        }
        return &bodies[location.body_index];
    }
    if (location.patch_index <= -2) {
        const std::size_t checkpoint_patch_index =
            static_cast<std::size_t>(-location.patch_index - 2);
        if (checkpoint_patch_index >= model.checkpoint_patches.size()) {
            return nullptr;
        }
        auto& bodies = model.checkpoint_patches[checkpoint_patch_index].spawned_bodies;
        if (location.body_index >= bodies.size()) {
            return nullptr;
        }
        return &bodies[location.body_index];
    }
    const std::size_t patch_index = static_cast<std::size_t>(location.patch_index);
    if (patch_index >= model.growth_patches.size()) {
        return nullptr;
    }
    auto& bodies = model.growth_patches[patch_index].spawned_bodies;
    if (location.body_index >= bodies.size()) {
        return nullptr;
    }
    return &bodies[location.body_index];
}

std::int32_t InitialBodyIndex(std::int32_t handle) {
    auto& locations = BodyLocations();
    if (handle < 0 || static_cast<std::size_t>(handle) >= locations.size()) {
        return -1;
    }
    const BodyLocation location = locations[static_cast<std::size_t>(handle)];
    if (location.patch_index != -1) {
        return -1;
    }
    return static_cast<std::int32_t>(location.body_index);
}

std::vector<circloo::ModelFixture>* ResolveFixtureTarget(
    std::int32_t target_type,
    std::int32_t target_index
) {
    if (target_type == 0) {
        circloo::ModelBody* body = ResolveBody(target_index);
        return body ? &body->fixtures : nullptr;
    }
    if (target_type == 1) {
        auto& patches = LoadedModel().growth_patches;
        if (target_index < 0 || static_cast<std::size_t>(target_index) >= patches.size()) {
            return nullptr;
        }
        return &patches[static_cast<std::size_t>(target_index)].replacement_fixtures;
    }
    return nullptr;
}

circloo::ModelFilter MakeFilter(
    std::int32_t category_bits,
    std::int32_t mask_bits,
    std::int32_t group_index
) {
    circloo::ModelFilter filter;
    filter.category_bits = static_cast<std::uint16_t>(category_bits);
    filter.mask_bits = static_cast<std::uint16_t>(mask_bits);
    filter.group_index = static_cast<std::int16_t>(group_index);
    return filter;
}

circloo::ModelFixture BaseFixture(
    double density,
    double friction,
    double restitution,
    std::int32_t sensor,
    std::int32_t category_bits,
    std::int32_t mask_bits,
    std::int32_t group_index
) {
    circloo::ModelFixture fixture;
    fixture.density = density;
    fixture.friction = friction;
    fixture.restitution = restitution;
    fixture.sensor = sensor != 0;
    fixture.filter = MakeFilter(category_bits, mask_bits, group_index);
    return fixture;
}

bool CopyVertices(circloo::ModelShape& shape, std::uint32_t vertex_count) {
    if (vertex_count > kVertexCapacity) {
        return false;
    }
    shape.vertices.assign(g_vertices, g_vertices + vertex_count);
    return true;
}

void StoreResult(const circloo::RuntimeSimulator& simulator) {
    const circloo::RuntimeState& state = simulator.state();
    const b2Body& player = simulator.player();
    const b2Vec2 position = player.GetPosition();
    const b2Vec2 velocity = player.GetLinearVelocity();

    g_result.frame = state.frame;
    g_result.checkpoint = state.checkpoint;
    g_result.growth_alarm = state.growth_alarm;
    g_result.boundary_radius_pixels = state.boundary_radius_pixels;
    for (std::size_t index = 0; index < 8; ++index) {
        g_result.checkpoint_frames[index] = state.checkpoint_frames[index];
    }
    g_result.x = position.x;
    g_result.y = position.y;
    g_result.vx = velocity.x;
    g_result.vy = velocity.y;
    g_result.angle = player.GetAngle();
    g_result.angular_velocity = player.GetAngularVelocity();

    const auto& bodies = simulator.bodies();
    g_body_state_count = static_cast<std::uint32_t>(
        bodies.size() < kBodyStateCapacity ? bodies.size() : kBodyStateCapacity
    );
    for (std::uint32_t index = 0; index < g_body_state_count; ++index) {
        const b2Body* body = bodies[index];
        const auto* tag = static_cast<const circloo::InstanceTag*>(body->GetUserData());
        const b2Vec2 body_position = body->GetPosition();
        const b2Vec2 body_velocity = body->GetLinearVelocity();
        WasmBodyState& target = g_body_states[index];
        target.instance_id = tag ? tag->id : -1;
        target.object_index = tag ? tag->object_index : -1;
        target.type = static_cast<std::int32_t>(body->GetType());
        target.flags =
            (body->IsSleepingAllowed() ? 1 : 0) |
            (body->IsAwake() ? 2 : 0) |
            (body->IsActive() ? 4 : 0) |
            (body->IsBullet() ? 8 : 0) |
            (body->IsFixedRotation() ? 16 : 0);
        target.x = body_position.x;
        target.y = body_position.y;
        target.vx = body_velocity.x;
        target.vy = body_velocity.y;
        target.angle = body->GetAngle();
        target.angular_velocity = body->GetAngularVelocity();
        target.sleep_time = body->GetSleepTime();
        float32 mass = 0.0;
        float32 inverse_mass = 0.0;
        float32 inertia = 0.0;
        float32 inverse_inertia = 0.0;
        b2Vec2 local_center;
        body->GetCapturedMassState(
            mass,
            inverse_mass,
            inertia,
            inverse_inertia,
            local_center
        );
        target.mass = mass;
        target.inverse_mass = inverse_mass;
        target.inertia = inertia;
        target.inverse_inertia = inverse_inertia;
        target.local_center_x = local_center.x;
        target.local_center_y = local_center.y;
    }

    const auto& joints = simulator.joints();
    g_joint_state_count = static_cast<std::uint32_t>(
        joints.size() < kJointStateCapacity ? joints.size() : kJointStateCapacity
    );
    for (std::uint32_t index = 0; index < g_joint_state_count; ++index) {
        b2Joint* joint = joints[index];
        const auto* tag_a = static_cast<const circloo::InstanceTag*>(
            joint && joint->GetBodyA() ? joint->GetBodyA()->GetUserData() : nullptr
        );
        const auto* tag_b = static_cast<const circloo::InstanceTag*>(
            joint && joint->GetBodyB() ? joint->GetBodyB()->GetUserData() : nullptr
        );
        WasmJointState& target = g_joint_states[index];
        target.type = joint ? static_cast<std::int32_t>(joint->GetType()) : -1;
        target.body_a_id = tag_a ? tag_a->id : -1;
        target.body_b_id = tag_b ? tag_b->id : -1;
        target.limit_state = 0;
        target.impulse_x = 0.0;
        target.impulse_y = 0.0;
        target.impulse_z = 0.0;
        target.motor_impulse = 0.0;
        if (!joint) continue;
        if (joint->GetType() == e_revoluteJoint) {
            float32 impulse_x = 0.0;
            float32 impulse_y = 0.0;
            float32 impulse_z = 0.0;
            float32 motor_impulse = 0.0;
            b2LimitState limit_state = e_inactiveLimit;
            static_cast<const b2RevoluteJoint*>(joint)->GetCapturedSolverState(
                impulse_x,
                impulse_y,
                impulse_z,
                motor_impulse,
                limit_state
            );
            target.impulse_x = impulse_x;
            target.impulse_y = impulse_y;
            target.impulse_z = impulse_z;
            target.motor_impulse = motor_impulse;
            target.limit_state = static_cast<std::int32_t>(limit_state);
        } else if (joint->GetType() == e_ropeJoint) {
            float32 impulse = 0.0;
            b2LimitState limit_state = e_inactiveLimit;
            static_cast<const b2RopeJoint*>(joint)->GetCapturedSolverState(
                impulse,
                limit_state
            );
            target.impulse_x = impulse;
            target.limit_state = static_cast<std::int32_t>(limit_state);
        }
    }
}

bool MatchesReferenceFinish(const circloo::RuntimeSimulator& simulator) {
    const auto& expected = circloo::fixture::kReferenceFrames.back();
    const auto& state = simulator.state();
    const b2Body& player = simulator.player();
    const b2Vec2 position = player.GetPosition();
    const b2Vec2 velocity = player.GetLinearVelocity();

    return state.frame == expected.frame &&
        state.checkpoint == expected.checkpoint &&
        state.growth_alarm == expected.growth_alarm &&
        state.boundary_radius_pixels == expected.big_radius_pixels &&
        position.x == expected.x &&
        position.y == expected.y &&
        velocity.x == expected.vx &&
        velocity.y == expected.vy &&
        player.GetAngle() == expected.angle &&
        player.GetAngularVelocity() == expected.angular_velocity;
}

void RebuildReferenceBodyLocations() {
    auto& locations = BodyLocations();
    locations.clear();
    const auto& model = LoadedModel();
    locations.reserve(model.bodies.size());
    for (std::size_t index = 0; index < model.bodies.size(); ++index) {
        locations.push_back(BodyLocation{-1, static_cast<std::uint32_t>(index)});
    }
    for (std::size_t patch_index = 0; patch_index < model.growth_patches.size(); ++patch_index) {
        const auto& bodies = model.growth_patches[patch_index].spawned_bodies;
        for (std::size_t body_index = 0; body_index < bodies.size(); ++body_index) {
            locations.push_back(BodyLocation{
                static_cast<std::int32_t>(patch_index),
                static_cast<std::uint32_t>(body_index)
            });
        }
    }
    for (std::size_t patch_index = 0; patch_index < model.checkpoint_patches.size(); ++patch_index) {
        const auto& bodies = model.checkpoint_patches[patch_index].spawned_bodies;
        for (std::size_t body_index = 0; body_index < bodies.size(); ++body_index) {
            locations.push_back(BodyLocation{
                -static_cast<std::int32_t>(patch_index) - 2,
                static_cast<std::uint32_t>(body_index)
            });
        }
    }
    for (std::size_t patch_index = 0; patch_index < model.frame_patches.size(); ++patch_index) {
        const auto& bodies = model.frame_patches[patch_index].spawned_bodies;
        for (std::size_t body_index = 0; body_index < bodies.size(); ++body_index) {
            locations.push_back(BodyLocation{
                kFramePatchTargetBase - static_cast<std::int32_t>(patch_index),
                static_cast<std::uint32_t>(body_index)
            });
        }
    }
}

} // namespace

extern "C" {

std::uint32_t circloo_input_ptr() {
    return static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(g_inputs));
}

std::uint32_t circloo_input_capacity() {
    return kInputCapacity;
}

std::uint32_t circloo_vertex_ptr() {
    return static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(g_vertices));
}

std::uint32_t circloo_vertex_capacity() {
    return kVertexCapacity;
}

std::uint32_t circloo_result_ptr() {
    return static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(&g_result));
}

std::uint32_t circloo_result_size() {
    return sizeof(WasmResult);
}

std::uint32_t circloo_body_state_ptr() {
    return static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(g_body_states));
}

std::uint32_t circloo_body_state_count() {
    return g_body_state_count;
}

std::uint32_t circloo_body_state_capacity() {
    return kBodyStateCapacity;
}

std::uint32_t circloo_body_state_stride() {
    return sizeof(WasmBodyState);
}

std::uint32_t circloo_joint_state_ptr() {
    return static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(g_joint_states));
}

std::uint32_t circloo_joint_state_count() {
    return g_joint_state_count;
}

std::uint32_t circloo_joint_state_capacity() {
    return kJointStateCapacity;
}

std::uint32_t circloo_joint_state_stride() {
    return sizeof(WasmJointState);
}

std::int32_t circloo_model_debug_initial_frame() {
    return LoadedModel().lifecycle.initial_frame;
}

std::uint32_t circloo_model_debug_frame_patch_count() {
    return static_cast<std::uint32_t>(LoadedModel().frame_patches.size());
}

std::int32_t circloo_model_debug_frame_patch_frame(std::uint32_t index) {
    if (index >= LoadedModel().frame_patches.size()) {
        return -1;
    }
    return LoadedModel().frame_patches[index].frame;
}

void circloo_model_reset() {
    delete g_sequence_simulator;
    g_sequence_simulator = nullptr;
    LoadedModel() = circloo::RuntimeModel{};
    BodyLocations().clear();
    ModelReady() = false;
    g_body_state_count = 0;
    g_joint_state_count = 0;
}

void circloo_model_set_world(
    double gravity_x,
    double gravity_y,
    double scale,
    double step_rate,
    std::int32_t velocity_iterations,
    std::int32_t position_iterations,
    std::int32_t flags
) {
    auto& world = LoadedModel().world;
    world.gravity = circloo::ModelVec2{gravity_x, gravity_y};
    world.scale = scale;
    world.step_rate = step_rate;
    world.velocity_iterations = velocity_iterations;
    world.position_iterations = position_iterations;
    world.allow_sleep = (flags & 1) != 0;
    world.warm_starting = (flags & 2) != 0;
    world.continuous_physics = (flags & 4) != 0;
    world.sub_stepping = (flags & 8) != 0;
}

void circloo_model_set_lifecycle(
    std::int32_t initial_frame,
    std::int32_t initial_timer_started,
    std::int32_t initial_checkpoint,
    std::int32_t initial_growth_alarm,
    std::int32_t initial_boundary_radius_pixels,
    std::int32_t maximum_boundary_radius_pixels,
    std::int32_t growth_delay_frames
) {
    auto& lifecycle = LoadedModel().lifecycle;
    lifecycle.initial_frame = initial_frame;
    lifecycle.initial_timer_started = initial_timer_started != 0;
    lifecycle.initial_checkpoint = initial_checkpoint;
    lifecycle.initial_growth_alarm = initial_growth_alarm;
    lifecycle.initial_boundary_radius_pixels = initial_boundary_radius_pixels;
    lifecycle.maximum_boundary_radius_pixels = maximum_boundary_radius_pixels;
    lifecycle.growth_delay_frames = growth_delay_frames;
}

std::int32_t circloo_model_set_checkpoint_frame(
    std::int32_t checkpoint,
    std::int32_t frame
) {
    if (checkpoint < 0 || checkpoint >= 32) {
        return 0;
    }
    LoadedModel().lifecycle.checkpoint_frames[static_cast<std::size_t>(checkpoint)] = frame;
    return 1;
}

std::int32_t circloo_model_add_patch(
    std::int32_t boundary_radius_pixels,
    std::int32_t replace_body_handle
) {
    circloo::ModelWorldPatch patch;
    patch.boundary_radius_pixels = boundary_radius_pixels;
    patch.replace_body_index = InitialBodyIndex(replace_body_handle);
    auto& patches = LoadedModel().growth_patches;
    patches.push_back(std::move(patch));
    return static_cast<std::int32_t>(patches.size() - 1U);
}

std::int32_t circloo_model_add_checkpoint_patch(std::int32_t checkpoint) {
    if (checkpoint < 1) {
        return -1;
    }
    circloo::ModelCheckpointPatch patch;
    patch.checkpoint = checkpoint;
    auto& patches = LoadedModel().checkpoint_patches;
    patches.push_back(std::move(patch));
    return static_cast<std::int32_t>(patches.size() - 1U);
}

std::int32_t circloo_model_add_frame_patch(std::int32_t frame) {
    if (frame < 0) {
        return 0;
    }
    circloo::ModelFramePatch patch;
    patch.frame = frame;
    auto& patches = LoadedModel().frame_patches;
    patches.push_back(std::move(patch));
    return kFramePatchTargetBase - static_cast<std::int32_t>(patches.size() - 1U);
}

std::int32_t circloo_model_add_frame_patch_destroy(
    std::int32_t encoded_target,
    std::int32_t instance_id
) {
    if (encoded_target > kFramePatchTargetBase) {
        return 0;
    }
    const std::size_t frame_patch_index = static_cast<std::size_t>(
        kFramePatchTargetBase - encoded_target
    );
    auto& patches = LoadedModel().frame_patches;
    if (frame_patch_index >= patches.size()) {
        return 0;
    }
    patches[frame_patch_index].destroyed_instance_ids.push_back(instance_id);
    return 1;
}

std::int32_t circloo_model_add_frame_patch_body_update(
    std::int32_t encoded_target,
    std::int32_t instance_id,
    std::int32_t type,
    double linear_damping,
    double angular_damping,
    double gravity_scale,
    std::int32_t flags
) {
    if (encoded_target > kFramePatchTargetBase || instance_id < 0) {
        return 0;
    }
    const std::size_t frame_patch_index = static_cast<std::size_t>(
        kFramePatchTargetBase - encoded_target
    );
    auto& patches = LoadedModel().frame_patches;
    if (frame_patch_index >= patches.size()) {
        return 0;
    }

    circloo::ModelBodyUpdate update;
    update.instance_id = instance_id;
    update.type = type;
    update.linear_damping = linear_damping;
    update.angular_damping = angular_damping;
    update.gravity_scale = gravity_scale;
    update.allow_sleep = (flags & 1) != 0;
    update.awake = (flags & 2) != 0;
    update.active = (flags & 4) != 0;
    update.bullet = (flags & 8) != 0;
    update.fixed_rotation = (flags & 16) != 0;
    patches[frame_patch_index].body_updates.push_back(update);
    return 1;
}

std::int32_t circloo_model_add_frame_patch_body_state(
    std::int32_t encoded_target,
    std::int32_t instance_id,
    double position_x,
    double position_y,
    double angle,
    double velocity_x,
    double velocity_y,
    double angular_velocity,
    double sleep_time
) {
    if (encoded_target > kFramePatchTargetBase || instance_id < 0) {
        return 0;
    }
    const std::size_t frame_patch_index = static_cast<std::size_t>(
        kFramePatchTargetBase - encoded_target
    );
    auto& patches = LoadedModel().frame_patches;
    if (frame_patch_index >= patches.size()) return 0;

    circloo::ModelBodyStateUpdate update;
    update.instance_id = instance_id;
    update.position = circloo::ModelVec2{position_x, position_y};
    update.angle = angle;
    update.linear_velocity = circloo::ModelVec2{velocity_x, velocity_y};
    update.angular_velocity = angular_velocity;
    update.sleep_time = sleep_time;
    patches[frame_patch_index].body_state_updates.push_back(update);
    return 1;
}

std::int32_t circloo_model_add_frame_patch_contact(
    std::int32_t encoded_target,
    std::int32_t body_a_instance_id,
    std::int32_t fixture_a_index,
    std::int32_t child_a,
    std::int32_t body_b_instance_id,
    std::int32_t fixture_b_index,
    std::int32_t child_b,
    std::int32_t flags,
    double friction,
    double restitution,
    double tangent_speed,
    std::int32_t toi_count,
    double toi,
    std::int32_t point_count,
    double point0_x,
    double point0_y,
    double point0_normal_impulse,
    double point0_tangent_impulse,
    std::int32_t point0_id,
    double point1_x,
    double point1_y,
    double point1_normal_impulse,
    double point1_tangent_impulse,
    std::int32_t point1_id
) {
    if (encoded_target > kFramePatchTargetBase ||
        body_a_instance_id < 0 || body_b_instance_id < 0 ||
        fixture_a_index < 0 || fixture_b_index < 0 ||
        point_count < 1 || point_count > 2) {
        return 0;
    }
    const std::size_t frame_patch_index = static_cast<std::size_t>(
        kFramePatchTargetBase - encoded_target
    );
    auto& patches = LoadedModel().frame_patches;
    if (frame_patch_index >= patches.size()) return 0;

    circloo::ModelInstanceContact contact;
    contact.body_a_instance_id = body_a_instance_id;
    contact.fixture_a_index = fixture_a_index;
    contact.child_a = child_a;
    contact.body_b_instance_id = body_b_instance_id;
    contact.fixture_b_index = fixture_b_index;
    contact.child_b = child_b;
    contact.flags = static_cast<std::uint32_t>(flags);
    contact.friction = friction;
    contact.restitution = restitution;
    contact.tangent_speed = tangent_speed;
    contact.toi_count = toi_count;
    contact.toi = toi;
    contact.point_count = point_count;
    contact.points[0].local_point = circloo::ModelVec2{point0_x, point0_y};
    contact.points[0].normal_impulse = point0_normal_impulse;
    contact.points[0].tangent_impulse = point0_tangent_impulse;
    contact.points[0].id = static_cast<std::uint32_t>(point0_id);
    contact.points[1].local_point = circloo::ModelVec2{point1_x, point1_y};
    contact.points[1].normal_impulse = point1_normal_impulse;
    contact.points[1].tangent_impulse = point1_tangent_impulse;
    contact.points[1].id = static_cast<std::uint32_t>(point1_id);
    patches[frame_patch_index].contacts.push_back(contact);
    return 1;
}

std::int32_t circloo_model_add_frame_patch_joint(
    std::int32_t encoded_target,
    std::int32_t type,
    std::int32_t body_a_instance_id,
    std::int32_t body_b_instance_id,
    double anchor_a_x,
    double anchor_a_y,
    double anchor_b_x,
    double anchor_b_y,
    double local_anchor_a_x,
    double local_anchor_a_y,
    double local_anchor_b_x,
    double local_anchor_b_y,
    double reference_angle,
    double lower_angle,
    double upper_angle,
    double max_motor_torque,
    double motor_speed,
    double max_length,
    double impulse_x,
    double impulse_y,
    double impulse_z,
    double motor_impulse,
    std::int32_t limit_state,
    std::int32_t flags
) {
    if (encoded_target > kFramePatchTargetBase ||
        body_a_instance_id < 0 || body_b_instance_id < 0 ||
        (type != 1 && type != 10)) {
        return 0;
    }
    const std::size_t frame_patch_index = static_cast<std::size_t>(
        kFramePatchTargetBase - encoded_target
    );
    auto& patches = LoadedModel().frame_patches;
    if (frame_patch_index >= patches.size()) return 0;

    circloo::ModelJoint joint;
    joint.type = static_cast<circloo::ModelJointType>(type);
    joint.body_a_instance_id = body_a_instance_id;
    joint.body_b_instance_id = body_b_instance_id;
    joint.anchor_a = circloo::ModelVec2{anchor_a_x, anchor_a_y};
    joint.anchor_b = circloo::ModelVec2{anchor_b_x, anchor_b_y};
    joint.local_anchor_a = circloo::ModelVec2{local_anchor_a_x, local_anchor_a_y};
    joint.local_anchor_b = circloo::ModelVec2{local_anchor_b_x, local_anchor_b_y};
    joint.reference_angle = reference_angle;
    joint.lower_angle = lower_angle;
    joint.upper_angle = upper_angle;
    joint.max_motor_torque = max_motor_torque;
    joint.motor_speed = motor_speed;
    joint.max_length = max_length;
    joint.impulse = circloo::ModelVec2{impulse_x, impulse_y};
    joint.impulse_z = impulse_z;
    joint.motor_impulse = motor_impulse;
    joint.limit_state = limit_state;
    joint.collide_connected = (flags & 1) != 0;
    joint.enable_limit = (flags & 2) != 0;
    joint.enable_motor = (flags & 4) != 0;
    patches[frame_patch_index].spawned_joints.push_back(joint);
    return 1;
}

std::int32_t circloo_model_add_frame_patch_joint_destroy(
    std::int32_t encoded_target,
    std::int32_t type,
    std::int32_t body_a_instance_id,
    std::int32_t body_b_instance_id
) {
    if (encoded_target > kFramePatchTargetBase ||
        body_a_instance_id < 0 || body_b_instance_id < 0 ||
        (type != 1 && type != 10)) {
        return 0;
    }
    const std::size_t frame_patch_index = static_cast<std::size_t>(
        kFramePatchTargetBase - encoded_target
    );
    auto& patches = LoadedModel().frame_patches;
    if (frame_patch_index >= patches.size()) return 0;
    circloo::ModelJointKey key;
    key.type = static_cast<circloo::ModelJointType>(type);
    key.body_a_instance_id = body_a_instance_id;
    key.body_b_instance_id = body_b_instance_id;
    patches[frame_patch_index].destroyed_joints.push_back(key);
    return 1;
}

std::int32_t circloo_model_add_body(
    std::int32_t patch_index,
    std::int32_t instance_id,
    std::int32_t object_index,
    std::int32_t type,
    double position_x,
    double position_y,
    double angle,
    double velocity_x,
    double velocity_y,
    double angular_velocity,
    double linear_damping,
    double angular_damping,
    double gravity_scale,
    double sleep_time,
    double mass,
    double inverse_mass,
    double inertia,
    double inverse_inertia,
    double local_center_x,
    double local_center_y,
    std::int32_t has_captured_mass_state,
    std::int32_t flags
) {
    circloo::ModelBody body;
    body.instance_id = instance_id;
    body.object_index = object_index;
    body.type = type;
    body.position = circloo::ModelVec2{position_x, position_y};
    body.angle = angle;
    body.linear_velocity = circloo::ModelVec2{velocity_x, velocity_y};
    body.angular_velocity = angular_velocity;
    body.linear_damping = linear_damping;
    body.angular_damping = angular_damping;
    body.gravity_scale = gravity_scale;
    body.sleep_time = sleep_time;
    body.mass = mass;
    body.inverse_mass = inverse_mass;
    body.inertia = inertia;
    body.inverse_inertia = inverse_inertia;
    body.local_center = circloo::ModelVec2{local_center_x, local_center_y};
    body.has_captured_mass_state = has_captured_mass_state != 0;
    body.allow_sleep = (flags & 1) != 0;
    body.awake = (flags & 2) != 0;
    body.active = (flags & 4) != 0;
    body.bullet = (flags & 8) != 0;
    body.fixed_rotation = (flags & 16) != 0;

    BodyLocation location{};
    if (patch_index == -1) {
        auto& bodies = LoadedModel().bodies;
        bodies.push_back(std::move(body));
        location = BodyLocation{-1, static_cast<std::uint32_t>(bodies.size() - 1U)};
    } else if (patch_index <= kFramePatchTargetBase) {
        const std::size_t frame_patch_index = static_cast<std::size_t>(
            kFramePatchTargetBase - patch_index
        );
        auto& patches = LoadedModel().frame_patches;
        if (frame_patch_index >= patches.size()) {
            return -1;
        }
        auto& bodies = patches[frame_patch_index].spawned_bodies;
        bodies.push_back(std::move(body));
        location = BodyLocation{
            patch_index,
            static_cast<std::uint32_t>(bodies.size() - 1U)
        };
    } else if (patch_index <= -2) {
        const std::size_t checkpoint_patch_index =
            static_cast<std::size_t>(-patch_index - 2);
        auto& patches = LoadedModel().checkpoint_patches;
        if (checkpoint_patch_index >= patches.size()) {
            return -1;
        }
        auto& bodies = patches[checkpoint_patch_index].spawned_bodies;
        bodies.push_back(std::move(body));
        location = BodyLocation{
            patch_index,
            static_cast<std::uint32_t>(bodies.size() - 1U)
        };
    } else {
        auto& patches = LoadedModel().growth_patches;
        if (static_cast<std::size_t>(patch_index) >= patches.size()) {
            return -1;
        }
        auto& bodies = patches[static_cast<std::size_t>(patch_index)].spawned_bodies;
        bodies.push_back(std::move(body));
        location = BodyLocation{patch_index, static_cast<std::uint32_t>(bodies.size() - 1U)};
    }

    auto& locations = BodyLocations();
    locations.push_back(location);
    return static_cast<std::int32_t>(locations.size() - 1U);
}

std::int32_t circloo_model_set_player(
    std::int32_t body_handle,
    double room_speed,
    double input_scale,
    double primary_acceleration,
    double secondary_acceleration,
    std::int32_t secondary_enabled,
    double collection_radius_pixels
) {
    const std::int32_t body_index = InitialBodyIndex(body_handle);
    if (body_index < 0) {
        return 0;
    }
    auto& player = LoadedModel().player;
    player.body_index = body_index;
    player.room_speed = room_speed;
    player.input_scale = input_scale;
    player.primary_acceleration = primary_acceleration;
    player.secondary_acceleration = secondary_acceleration;
    player.secondary_acceleration_enabled = secondary_enabled != 0;
    player.collection_radius_pixels = collection_radius_pixels;
    return 1;
}

std::int32_t circloo_model_add_joint(
    std::int32_t type,
    std::int32_t body_a_handle,
    std::int32_t body_b_handle,
    double anchor_a_x,
    double anchor_a_y,
    double anchor_b_x,
    double anchor_b_y,
    double local_anchor_a_x,
    double local_anchor_a_y,
    double local_anchor_b_x,
    double local_anchor_b_y,
    double reference_angle,
    double lower_angle,
    double upper_angle,
    double max_motor_torque,
    double motor_speed,
    double max_length,
    double impulse_x,
    double impulse_y,
    double impulse_z,
    double motor_impulse,
    std::int32_t limit_state,
    std::int32_t flags
) {
    const std::int32_t body_a_index = InitialBodyIndex(body_a_handle);
    const std::int32_t body_b_index = InitialBodyIndex(body_b_handle);
    if (body_a_index < 0 || body_b_index < 0 || (type != 1 && type != 10)) {
        return 0;
    }
    circloo::ModelJoint joint;
    joint.type = static_cast<circloo::ModelJointType>(type);
    joint.body_a_index = body_a_index;
    joint.body_b_index = body_b_index;
    joint.anchor_a = circloo::ModelVec2{anchor_a_x, anchor_a_y};
    joint.anchor_b = circloo::ModelVec2{anchor_b_x, anchor_b_y};
    joint.local_anchor_a = circloo::ModelVec2{local_anchor_a_x, local_anchor_a_y};
    joint.local_anchor_b = circloo::ModelVec2{local_anchor_b_x, local_anchor_b_y};
    joint.reference_angle = reference_angle;
    joint.lower_angle = lower_angle;
    joint.upper_angle = upper_angle;
    joint.max_motor_torque = max_motor_torque;
    joint.motor_speed = motor_speed;
    joint.max_length = max_length;
    joint.impulse = circloo::ModelVec2{impulse_x, impulse_y};
    joint.impulse_z = impulse_z;
    joint.motor_impulse = motor_impulse;
    joint.limit_state = limit_state;
    joint.collide_connected = (flags & 1) != 0;
    joint.enable_limit = (flags & 2) != 0;
    joint.enable_motor = (flags & 4) != 0;
    LoadedModel().joints.push_back(joint);
    return 1;
}

std::int32_t circloo_model_add_contact(
    std::int32_t body_a_handle,
    std::int32_t fixture_a_index,
    std::int32_t child_a,
    std::int32_t body_b_handle,
    std::int32_t fixture_b_index,
    std::int32_t child_b,
    std::int32_t flags,
    double friction,
    double restitution,
    double tangent_speed,
    std::int32_t toi_count,
    double toi,
    std::int32_t point_count,
    double point0_x,
    double point0_y,
    double point0_normal_impulse,
    double point0_tangent_impulse,
    std::int32_t point0_id,
    double point1_x,
    double point1_y,
    double point1_normal_impulse,
    double point1_tangent_impulse,
    std::int32_t point1_id
) {
    const std::int32_t body_a_index = InitialBodyIndex(body_a_handle);
    const std::int32_t body_b_index = InitialBodyIndex(body_b_handle);
    if (body_a_index < 0 || body_b_index < 0 ||
        fixture_a_index < 0 || fixture_b_index < 0 ||
        point_count < 0 || point_count > 2) {
        return 0;
    }
    circloo::ModelContact contact;
    contact.body_a_index = body_a_index;
    contact.fixture_a_index = fixture_a_index;
    contact.child_a = child_a;
    contact.body_b_index = body_b_index;
    contact.fixture_b_index = fixture_b_index;
    contact.child_b = child_b;
    contact.flags = static_cast<std::uint32_t>(flags);
    contact.friction = friction;
    contact.restitution = restitution;
    contact.tangent_speed = tangent_speed;
    contact.toi_count = toi_count;
    contact.toi = toi;
    contact.point_count = point_count;
    contact.points[0].local_point = circloo::ModelVec2{point0_x, point0_y};
    contact.points[0].normal_impulse = point0_normal_impulse;
    contact.points[0].tangent_impulse = point0_tangent_impulse;
    contact.points[0].id = static_cast<std::uint32_t>(point0_id);
    contact.points[1].local_point = circloo::ModelVec2{point1_x, point1_y};
    contact.points[1].normal_impulse = point1_normal_impulse;
    contact.points[1].tangent_impulse = point1_tangent_impulse;
    contact.points[1].id = static_cast<std::uint32_t>(point1_id);
    LoadedModel().contacts.push_back(contact);
    return 1;
}

std::int32_t circloo_model_add_circle_fixture(
    std::int32_t target_type,
    std::int32_t target_index,
    double radius,
    double center_x,
    double center_y,
    double density,
    double friction,
    double restitution,
    std::int32_t sensor,
    std::int32_t category_bits,
    std::int32_t mask_bits,
    std::int32_t group_index
) {
    auto* fixtures = ResolveFixtureTarget(target_type, target_index);
    if (!fixtures) {
        return 0;
    }
    circloo::ModelFixture fixture = BaseFixture(
        density, friction, restitution, sensor, category_bits, mask_bits, group_index
    );
    fixture.shape.type = circloo::ModelShapeType::Circle;
    fixture.shape.radius = radius;
    fixture.shape.center = circloo::ModelVec2{center_x, center_y};
    fixtures->push_back(std::move(fixture));
    return 1;
}

std::int32_t circloo_model_add_polygon_fixture(
    std::int32_t target_type,
    std::int32_t target_index,
    std::uint32_t vertex_count,
    double radius,
    double density,
    double friction,
    double restitution,
    std::int32_t sensor,
    std::int32_t category_bits,
    std::int32_t mask_bits,
    std::int32_t group_index
) {
    auto* fixtures = ResolveFixtureTarget(target_type, target_index);
    if (!fixtures || vertex_count < 3U) {
        return 0;
    }
    circloo::ModelFixture fixture = BaseFixture(
        density, friction, restitution, sensor, category_bits, mask_bits, group_index
    );
    fixture.shape.type = circloo::ModelShapeType::Polygon;
    fixture.shape.radius = radius;
    if (!CopyVertices(fixture.shape, vertex_count)) {
        return 0;
    }
    fixtures->push_back(std::move(fixture));
    return 1;
}

std::int32_t circloo_model_add_edge_fixture(
    std::int32_t target_type,
    std::int32_t target_index,
    double radius,
    std::int32_t has_previous,
    double previous_x,
    double previous_y,
    std::int32_t has_next,
    double next_x,
    double next_y,
    double density,
    double friction,
    double restitution,
    std::int32_t sensor,
    std::int32_t category_bits,
    std::int32_t mask_bits,
    std::int32_t group_index
) {
    auto* fixtures = ResolveFixtureTarget(target_type, target_index);
    if (!fixtures) {
        return 0;
    }
    circloo::ModelFixture fixture = BaseFixture(
        density, friction, restitution, sensor, category_bits, mask_bits, group_index
    );
    fixture.shape.type = circloo::ModelShapeType::Edge;
    fixture.shape.radius = radius;
    if (!CopyVertices(fixture.shape, 2U)) {
        return 0;
    }
    fixture.shape.has_previous_vertex = has_previous != 0;
    fixture.shape.previous_vertex = circloo::ModelVec2{previous_x, previous_y};
    fixture.shape.has_next_vertex = has_next != 0;
    fixture.shape.next_vertex = circloo::ModelVec2{next_x, next_y};
    fixtures->push_back(std::move(fixture));
    return 1;
}

std::int32_t circloo_model_add_chain_fixture(
    std::int32_t target_type,
    std::int32_t target_index,
    std::uint32_t vertex_count,
    double radius,
    std::int32_t loop,
    std::int32_t has_previous,
    double previous_x,
    double previous_y,
    std::int32_t has_next,
    double next_x,
    double next_y,
    double density,
    double friction,
    double restitution,
    std::int32_t sensor,
    std::int32_t category_bits,
    std::int32_t mask_bits,
    std::int32_t group_index
) {
    auto* fixtures = ResolveFixtureTarget(target_type, target_index);
    if (!fixtures || vertex_count < (loop != 0 ? 3U : 2U)) {
        return 0;
    }
    circloo::ModelFixture fixture = BaseFixture(
        density, friction, restitution, sensor, category_bits, mask_bits, group_index
    );
    fixture.shape.type = circloo::ModelShapeType::Chain;
    fixture.shape.radius = radius;
    fixture.shape.loop = loop != 0;
    if (!CopyVertices(fixture.shape, vertex_count)) {
        return 0;
    }
    fixture.shape.has_previous_vertex = has_previous != 0;
    fixture.shape.previous_vertex = circloo::ModelVec2{previous_x, previous_y};
    fixture.shape.has_next_vertex = has_next != 0;
    fixture.shape.next_vertex = circloo::ModelVec2{next_x, next_y};
    fixtures->push_back(std::move(fixture));
    return 1;
}

std::int32_t circloo_model_add_collectible(
    std::int32_t instance_id,
    std::int32_t object_index,
    std::int32_t body_handle,
    double x_pixels,
    double y_pixels,
    double radius_pixels,
    std::int32_t flags
) {
    circloo::ModelCollectible collectible;
    collectible.instance_id = instance_id;
    collectible.object_index = object_index;
    collectible.body_index = body_handle < 0 ? -1 : InitialBodyIndex(body_handle);
    if (body_handle >= 0 && collectible.body_index < 0) {
        return 0;
    }
    collectible.x_pixels = x_pixels;
    collectible.y_pixels = y_pixels;
    collectible.radius_pixels = radius_pixels;
    collectible.active = (flags & 1) != 0;
    collectible.collected = (flags & 2) != 0;
    collectible.excluded = (flags & 4) != 0;
    collectible.counts_checkpoint = (flags & 8) != 0;
    collectible.starts_growth_alarm = (flags & 16) != 0;
    collectible.player_triggered = (flags & 32) != 0;
    LoadedModel().collectibles.push_back(collectible);
    return 1;
}

std::int32_t circloo_model_finalize() {
    const auto& model = LoadedModel();
    if (model.world.scale <= 0.0 || model.world.step_rate <= 0.0 ||
        model.player.body_index < 0 ||
        static_cast<std::size_t>(model.player.body_index) >= model.bodies.size()) {
        ModelReady() = false;
        return 0;
    }
    for (const auto& patch : model.growth_patches) {
        if (patch.replace_body_index >= 0 &&
            static_cast<std::size_t>(patch.replace_body_index) >= model.bodies.size()) {
            ModelReady() = false;
            return 0;
        }
    }
    for (const auto& joint : model.joints) {
        if (joint.body_a_index < 0 || joint.body_b_index < 0 ||
            static_cast<std::size_t>(joint.body_a_index) >= model.bodies.size() ||
            static_cast<std::size_t>(joint.body_b_index) >= model.bodies.size()) {
            ModelReady() = false;
            return 0;
        }
    }
    for (const auto& contact : model.contacts) {
        if (contact.body_a_index < 0 || contact.body_b_index < 0 ||
            static_cast<std::size_t>(contact.body_a_index) >= model.bodies.size() ||
            static_cast<std::size_t>(contact.body_b_index) >= model.bodies.size() ||
            contact.fixture_a_index < 0 || contact.fixture_b_index < 0 ||
            static_cast<std::size_t>(contact.fixture_a_index) >=
                model.bodies[static_cast<std::size_t>(contact.body_a_index)].fixtures.size() ||
            static_cast<std::size_t>(contact.fixture_b_index) >=
                model.bodies[static_cast<std::size_t>(contact.body_b_index)].fixtures.size() ||
            contact.point_count < 0 || contact.point_count > 2) {
            ModelReady() = false;
            return 0;
        }
    }
    ModelReady() = true;
    return 1;
}

std::int32_t circloo_simulate(
    std::uint32_t input_count,
    std::int32_t finish_checkpoint
) {
    if (!ModelReady()) {
        return -1;
    }
    if (input_count > kInputCapacity) {
        input_count = kInputCapacity;
    }
    if (finish_checkpoint < 1) {
        finish_checkpoint = 7;
    }

    circloo::RuntimeSimulator simulator(LoadedModel());
    for (std::uint32_t index = 0; index < input_count; ++index) {
        if (simulator.state().checkpoint >= finish_checkpoint) {
            break;
        }
        simulator.Step(g_inputs[index]);
    }
    StoreResult(simulator);
    return simulator.state().checkpoint >= finish_checkpoint ? 1 : 0;
}

std::int32_t circloo_sequence_begin() {
    if (!ModelReady()) {
        return 0;
    }
    delete g_sequence_simulator;
    g_sequence_simulator = new circloo::RuntimeSimulator(LoadedModel());
    StoreResult(*g_sequence_simulator);
    return 1;
}

std::int32_t circloo_sequence_step(
    std::int32_t input,
    std::int32_t finish_checkpoint
) {
    if (!g_sequence_simulator) {
        return -1;
    }
    if (finish_checkpoint < 1) {
        finish_checkpoint = 7;
    }
    if (g_sequence_simulator->state().checkpoint < finish_checkpoint) {
        g_sequence_simulator->Step(static_cast<std::uint8_t>(input & 3));
    }
    StoreResult(*g_sequence_simulator);
    return g_sequence_simulator->state().checkpoint >= finish_checkpoint ? 1 : 0;
}

void circloo_sequence_end() {
    delete g_sequence_simulator;
    g_sequence_simulator = nullptr;
}

std::int32_t circloo_reference_model_load() {
    LoadedModel() = circloo::MakeLevel1ReferenceModel();
    RebuildReferenceBodyLocations();
    ModelReady() = true;
    return 1;
}

std::int32_t circloo_reference_self_test() {
    circloo::RuntimeModel model = circloo::MakeLevel1ReferenceModel();
    circloo::RuntimeSimulator simulator(model);
    for (std::uint8_t input : circloo::fixture::kInputBits) {
        if (simulator.state().checkpoint >= 7) {
            break;
        }
        simulator.Step(input);
    }
    StoreResult(simulator);
    return MatchesReferenceFinish(simulator) ? 1 : 0;
}

} // extern "C"
