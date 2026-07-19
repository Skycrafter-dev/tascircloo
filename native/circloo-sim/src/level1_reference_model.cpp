#include "level1_reference_model.h"

#include "level1_frame300_fixture.h"

#include <utility>

namespace circloo {
namespace {

ModelFixture CircleFixture(
    double radius,
    double density,
    double friction,
    double restitution,
    std::uint16_t category_bits,
    std::uint16_t mask_bits,
    std::int16_t group_index
) {
    ModelFixture result;
    result.shape.type = ModelShapeType::Circle;
    result.shape.radius = radius;
    result.density = density;
    result.friction = friction;
    result.restitution = restitution;
    result.filter.category_bits = category_bits;
    result.filter.mask_bits = mask_bits;
    result.filter.group_index = group_index;
    return result;
}

template <std::size_t Count>
ModelFixture ChainFixture(const std::array<fixture::Vec2, Count>& vertices) {
    ModelFixture result;
    result.shape.type = ModelShapeType::Chain;
    result.shape.radius = 0.01;
    result.shape.loop = true;
    result.shape.vertices.reserve(vertices.size());
    for (const fixture::Vec2& vertex : vertices) {
        result.shape.vertices.push_back(ModelVec2{vertex.x, vertex.y});
    }
    result.density = 0.0;
    result.friction = fixture::kChainFriction;
    result.restitution = fixture::kChainRestitution;
    result.filter.category_bits = fixture::kChainCategoryBits;
    result.filter.mask_bits = fixture::kChainMaskBits;
    result.filter.group_index = fixture::kChainGroupIndex;
    return result;
}

ModelBody StaticCircleBody(const fixture::StaticCircle& circle) {
    ModelBody body;
    body.instance_id = circle.instance_id;
    body.type = 0;
    body.position = ModelVec2{circle.x, circle.y};
    body.fixtures.push_back(CircleFixture(
        circle.radius,
        0.0,
        circle.friction,
        circle.restitution,
        circle.category_bits,
        circle.mask_bits,
        circle.group_index
    ));
    return body;
}

} // namespace

RuntimeModel MakeLevel1ReferenceModel() {
    RuntimeModel model;
    model.world.gravity = ModelVec2{fixture::kGravity.x, fixture::kGravity.y};
    model.world.scale = fixture::kScale;
    model.world.step_rate = fixture::kStepRate;
    model.world.velocity_iterations = fixture::kVelocityIterations;
    model.world.position_iterations = fixture::kPositionIterations;

    model.player.body_index = 1;
    model.player.room_speed = fixture::kStepRate;
    model.player.input_scale = 1.0;
    model.player.primary_acceleration = 0.52;
    model.player.secondary_acceleration = 0.01;
    model.player.secondary_acceleration_enabled = true;
    model.player.collection_radius_pixels = 32.5;

    model.lifecycle.initial_frame = 299;
    model.lifecycle.initial_checkpoint = 4;
    model.lifecycle.initial_growth_alarm = -1;
    model.lifecycle.initial_boundary_radius_pixels = 1000;
    model.lifecycle.maximum_boundary_radius_pixels = 1400;
    model.lifecycle.growth_delay_frames = 10;
    model.lifecycle.checkpoint_frames[1] = 64;
    model.lifecycle.checkpoint_frames[2] = 93;
    model.lifecycle.checkpoint_frames[3] = 156;
    model.lifecycle.checkpoint_frames[4] = 245;

    ModelBody boundary;
    boundary.instance_id = 2000001;
    boundary.object_index = 1;
    boundary.type = 0;
    boundary.fixtures.push_back(ChainFixture(fixture::kChainVertices));
    model.bodies.push_back(std::move(boundary));

    ModelBody player;
    player.instance_id = 2000002;
    player.object_index = 20;
    player.type = 2;
    player.position = ModelVec2{fixture::kPlayerPosition.x, fixture::kPlayerPosition.y};
    player.angle = fixture::kPlayerAngle;
    player.linear_velocity = ModelVec2{fixture::kPlayerVelocity.x, fixture::kPlayerVelocity.y};
    player.angular_velocity = fixture::kPlayerAngularVelocity;
    player.linear_damping = fixture::kPlayerLinearDamping;
    player.angular_damping = fixture::kPlayerAngularDamping;
    player.gravity_scale = fixture::kPlayerGravityScale;
    player.allow_sleep = fixture::kPlayerAllowSleep;
    player.awake = fixture::kPlayerAwake;
    player.active = fixture::kPlayerActive;
    player.bullet = fixture::kPlayerBullet;
    player.fixed_rotation = fixture::kPlayerFixedRotation;
    player.fixtures.push_back(CircleFixture(
        fixture::kPlayerRadius,
        fixture::kPlayerDensity,
        fixture::kPlayerFriction,
        fixture::kPlayerRestitution,
        fixture::kPlayerCategoryBits,
        fixture::kPlayerMaskBits,
        fixture::kPlayerGroupIndex
    ));
    model.bodies.push_back(std::move(player));

    for (const fixture::StaticCircle& circle : fixture::kStaticCircles) {
        model.bodies.push_back(StaticCircleBody(circle));
    }

    for (const fixture::Collectible& source : fixture::kCollectibles) {
        ModelCollectible collectible;
        collectible.instance_id = source.instance_id;
        collectible.object_index = 21;
        collectible.x_pixels = source.x_pixels;
        collectible.y_pixels = source.y_pixels;
        collectible.radius_pixels = 24.0;
        model.collectibles.push_back(collectible);
    }

    ModelWorldPatch radius_1200;
    radius_1200.boundary_radius_pixels = 1200;
    radius_1200.replace_body_index = 0;
    radius_1200.replacement_fixtures.push_back(
        ChainFixture(fixture::kChainVertices1200)
    );
    for (const fixture::StaticCircle& circle : fixture::kGrowthStaticCircles) {
        radius_1200.spawned_bodies.push_back(StaticCircleBody(circle));
    }
    model.growth_patches.push_back(std::move(radius_1200));

    ModelWorldPatch radius_1400;
    radius_1400.boundary_radius_pixels = 1400;
    radius_1400.replace_body_index = 0;
    radius_1400.replacement_fixtures.push_back(
        ChainFixture(fixture::kChainVertices1400)
    );
    model.growth_patches.push_back(std::move(radius_1400));

    return model;
}

} // namespace circloo
