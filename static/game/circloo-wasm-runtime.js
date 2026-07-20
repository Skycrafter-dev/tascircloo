(function installCirclooWasmRuntime(scope) {
	'use strict';

	const DEFAULT_URL = '/game/circloo-sim.wasm';

	function finite(value, fallback = 0) {
		const number = Number(value);
		return Number.isFinite(number) ? number : fallback;
	}

	function integer(value, fallback = 0) {
		return Math.trunc(finite(value, fallback));
	}

	function bit(value, mask) {
		return value ? mask : 0;
	}

	function requireExport(exports, name) {
		const value = exports && exports[name];
		if (typeof value !== 'function') throw new Error(`Missing Wasm export ${name}`);
		return value;
	}

	function fixtureFlags(fixture) {
		return fixture && fixture.sensor ? 1 : 0;
	}

	function bodyFlags(body) {
		return (
			bit(body.allowSleep !== false, 1) |
			bit(body.awake !== false, 2) |
			bit(body.active !== false, 4) |
			bit(!!body.bullet, 8) |
			bit(!!body.fixedRotation, 16)
		);
	}

	function worldFlags(world) {
		return (
			bit(world.allowSleep !== false, 1) |
			bit(world.warmStarting !== false, 2) |
			bit(world.continuousPhysics !== false, 4) |
			bit(!!world.subStepping, 8)
		);
	}

	function collectibleFlags(collectible) {
		return (
			bit(collectible.active !== false, 1) |
			bit(!!collectible.collected, 2) |
			bit(!!collectible.excluded, 4) |
			bit(collectible.countsCheckpoint !== false, 8) |
			bit(collectible.startsGrowthAlarm !== false, 16) |
			bit(collectible.playerTriggered !== false, 32)
		);
	}

	function samePoint(left, right) {
		return !!(
			left &&
			right &&
			finite(left.x, NaN) === finite(right.x, NaN) &&
			finite(left.y, NaN) === finite(right.y, NaN)
		);
	}

	function normalizeShape(source) {
		if (!source) throw new Error('Captured fixture shape is missing');
		const type = integer(source.type, -1);
		let vertices = Array.isArray(source.vertices)
			? source.vertices.map((vertex) => ({ x: finite(vertex && vertex.x), y: finite(vertex && vertex.y) }))
			: [];
		let loop = false;
		if (type === 3 && vertices.length >= 4 && samePoint(vertices[0], vertices[vertices.length - 1])) {
			// Box2D stores one extra copy of the first vertex for CreateLoop. Preserve
			// any duplicate endpoint supplied by GameMaker and remove only Box2D's copy.
			vertices = vertices.slice(0, -1);
			loop = true;
		}
		return {
			type,
			radius: finite(source.radius, type === 0 ? 0 : 0.01),
			center: source.center
				? { x: finite(source.center.x), y: finite(source.center.y) }
				: { x: 0, y: 0 },
			vertices,
			previousVertex: source.previousVertex
				? { x: finite(source.previousVertex.x), y: finite(source.previousVertex.y) }
				: { x: 0, y: 0 },
			nextVertex: source.nextVertex
				? { x: finite(source.nextVertex.x), y: finite(source.nextVertex.y) }
				: { x: 0, y: 0 },
			hasPreviousVertex: !!source.hasPreviousVertex,
			hasNextVertex: !!source.hasNextVertex,
			loop
		};
	}

	function normalizeFixture(source) {
		const filter = source && source.filter ? source.filter : {};
		return {
			shape: normalizeShape(source && source.shape),
			density: finite(source && source.density),
			friction: finite(source && source.friction, 0.2),
			restitution: finite(source && source.restitution),
			sensor: !!(source && source.sensor),
			filter: {
				categoryBits: integer(filter.categoryBits, 1),
				maskBits: integer(filter.maskBits, 0xffff),
				groupIndex: integer(filter.groupIndex)
			}
		};
	}

	function normalizeBody(source) {
		const position = source && source.position ? source.position : {};
		const velocity = source && source.linearVelocity ? source.linearVelocity : {};
		return {
			instanceId: integer(source && (source.instanceId ?? source.userId), -1),
			objectIndex: integer(source && source.objectIndex, -1),
			type: integer(source && source.type),
			position: { x: finite(position.x), y: finite(position.y) },
			angle: finite(source && source.angle),
			linearVelocity: { x: finite(velocity.x), y: finite(velocity.y) },
			angularVelocity: finite(source && source.angularVelocity),
			linearDamping: finite(source && source.linearDamping),
			angularDamping: finite(source && source.angularDamping),
			gravityScale: finite(source && source.gravityScale, 1),
			sleepTime: finite(source && source.sleepTime),
			mass: finite(source && source.mass),
			inverseMass: finite(source && source.inverseMass),
			inertia: finite(source && source.inertia),
			inverseInertia: finite(source && source.inverseInertia),
			localCenter: source && source.localCenter
				? { x: finite(source.localCenter.x), y: finite(source.localCenter.y) }
				: { x: 0, y: 0 },
			hasCapturedMassState: !!(source && source.hasCapturedMassState),
			allowSleep: source ? source.allowSleep !== false : true,
			awake: source ? source.awake !== false : true,
			active: source ? source.active !== false : true,
			bullet: !!(source && source.bullet),
			fixedRotation: !!(source && source.fixedRotation),
			// Fixture linked lists are also newest-first.
			fixtures: Array.isArray(source && source.fixtures)
				? source.fixtures.slice().reverse().map(normalizeFixture)
				: []
		};
	}

	function normalizeContact(source, inspectionBodies, bodyIndexById) {
		const originalA = inspectionBodies[integer(source && source.bodyA, -1)];
		const originalB = inspectionBodies[integer(source && source.bodyB, -1)];
		const bodyAIndex = bodyIndexById.get(integer(originalA && originalA.userId, -1));
		const bodyBIndex = bodyIndexById.get(integer(originalB && originalB.userId, -1));
		const manifold = source && source.manifold ? source.manifold : {};
		return {
			bodyAIndex: Number.isInteger(bodyAIndex) ? bodyAIndex : -1,
			fixtureAIndex: integer(source && source.fixtureA, -1),
			childA: integer(source && source.childA),
			bodyBIndex: Number.isInteger(bodyBIndex) ? bodyBIndex : -1,
			fixtureBIndex: integer(source && source.fixtureB, -1),
			childB: integer(source && source.childB),
			flags: integer(source && source.flags),
			friction: finite(source && source.friction),
			restitution: finite(source && source.restitution),
			tangentSpeed: finite(source && source.tangentSpeed),
			toiCount: integer(source && source.toiCount),
			toi: finite(source && source.toi),
			manifold: {
				type: integer(manifold.type),
				localNormal: {
					x: finite(manifold.localNormal && manifold.localNormal.x),
					y: finite(manifold.localNormal && manifold.localNormal.y)
				},
				localPoint: {
					x: finite(manifold.localPoint && manifold.localPoint.x),
					y: finite(manifold.localPoint && manifold.localPoint.y)
				},
				points: (manifold.points || []).slice(0, 2).map((point) => ({
					localPoint: {
						x: finite(point && point.localPoint && point.localPoint.x),
						y: finite(point && point.localPoint && point.localPoint.y)
					},
					normalImpulse: finite(point && point.normalImpulse),
					tangentImpulse: finite(point && point.tangentImpulse),
					id: integer(point && point.id)
				}))
			}
		};
	}

	function normalizeInstanceContact(source) {
		const manifold = source && source.manifold ? source.manifold : {};
		return {
			bodyAInstanceId: integer(source && source.bodyAInstanceId, -1),
			fixtureAIndex: integer(source && source.fixtureAIndex, -1),
			childA: integer(source && source.childA),
			bodyBInstanceId: integer(source && source.bodyBInstanceId, -1),
			fixtureBIndex: integer(source && source.fixtureBIndex, -1),
			childB: integer(source && source.childB),
			flags: integer(source && source.flags),
			friction: finite(source && source.friction),
			restitution: finite(source && source.restitution),
			tangentSpeed: finite(source && source.tangentSpeed),
			toiCount: integer(source && source.toiCount),
			toi: finite(source && source.toi),
			manifold: {
				points: (manifold.points || []).slice(0, 2).map((point) => ({
					localPoint: {
						x: finite(point && point.localPoint && point.localPoint.x),
						y: finite(point && point.localPoint && point.localPoint.y)
					},
					normalImpulse: finite(point && point.normalImpulse),
					tangentImpulse: finite(point && point.tangentImpulse),
					id: integer(point && point.id)
				}))
			}
		};
	}

	function localPoint(body, point) {
		const dx = finite(point && point.x) - finite(body && body.position && body.position.x);
		const dy = finite(point && point.y) - finite(body && body.position && body.position.y);
		const angle = finite(body && body.angle);
		const cosine = Math.cos(angle);
		const sine = Math.sin(angle);
		return {
			x: cosine * dx + sine * dy,
			y: -sine * dx + cosine * dy
		};
	}

	function normalizeJoint(source, inspectionBodies, bodyIndexById) {
		const raw = source && source.raw ? source.raw : {};
		const originalA = inspectionBodies[integer(source && source.bodyA, -1)];
		const originalB = inspectionBodies[integer(source && source.bodyB, -1)];
		const bodyAIndex = bodyIndexById.get(integer(originalA && originalA.userId, -1));
		const bodyBIndex = bodyIndexById.get(integer(originalB && originalB.userId, -1));
		const anchorA = source && source.anchorA ? source.anchorA : {};
		const anchorB = source && source.anchorB ? source.anchorB : anchorA;
		const impulse = source && source.impulse ? source.impulse : {};
		return {
			type: integer(source && source.type, -1),
			bodyAIndex: Number.isInteger(bodyAIndex) ? bodyAIndex : -1,
			bodyBIndex: Number.isInteger(bodyBIndex) ? bodyBIndex : -1,
			anchorA: { x: finite(anchorA.x), y: finite(anchorA.y) },
			anchorB: { x: finite(anchorB.x), y: finite(anchorB.y) },
			localAnchorA: source && source.localAnchorA
				? { x: finite(source.localAnchorA.x), y: finite(source.localAnchorA.y) }
				: localPoint(originalA, anchorA),
			localAnchorB: source && source.localAnchorB
				? { x: finite(source.localAnchorB.x), y: finite(source.localAnchorB.y) }
				: localPoint(originalB, anchorB),
			referenceAngle: finite(raw._0P1),
			lowerAngle: finite(raw._2P1),
			upperAngle: finite(raw._3P1),
			maxMotorTorque: finite(raw._4P1),
			motorSpeed: finite(raw._5P1),
			maxLength: finite(raw._bT1),
			impulse: {
				x: finite(impulse.x),
				y: finite(impulse.y),
				z: finite(impulse.z)
			},
			motorImpulse: finite(source && source.motorImpulse, raw._6P1),
			limitState: integer(source && source.limitState, raw._9P1 ?? raw._cT1),
			collideConnected: !!(source && source.collideConnected),
			enableLimit: !!raw._7P1,
			enableMotor: !!raw._8P1
		};
	}

	function normalizeInstanceJoint(source) {
		const anchorA = source && source.anchorA ? source.anchorA : {};
		const anchorB = source && source.anchorB ? source.anchorB : anchorA;
		const localAnchorA = source && source.localAnchorA ? source.localAnchorA : {};
		const localAnchorB = source && source.localAnchorB ? source.localAnchorB : {};
		const impulse = source && source.impulse ? source.impulse : {};
		return {
			type: integer(source && source.type, -1),
			bodyAInstanceId: integer(source && source.bodyAId, -1),
			bodyBInstanceId: integer(source && source.bodyBId, -1),
			anchorA: { x: finite(anchorA.x), y: finite(anchorA.y) },
			anchorB: { x: finite(anchorB.x), y: finite(anchorB.y) },
			localAnchorA: { x: finite(localAnchorA.x), y: finite(localAnchorA.y) },
			localAnchorB: { x: finite(localAnchorB.x), y: finite(localAnchorB.y) },
			referenceAngle: finite(source && source.referenceAngle),
			lowerAngle: finite(source && source.lowerAngle),
			upperAngle: finite(source && source.upperAngle),
			maxMotorTorque: finite(source && source.maxMotorTorque),
			motorSpeed: finite(source && source.motorSpeed),
			maxLength: finite(source && source.maxLength),
			impulse: {
				x: finite(impulse.x),
				y: finite(impulse.y),
				z: finite(impulse.z)
			},
			motorImpulse: finite(source && source.motorImpulse),
			limitState: integer(source && source.limitState),
			collideConnected: !!(source && source.collideConnected),
			enableLimit: !!(source && source.enableLimit),
			enableMotor: !!(source && source.enableMotor)
		};
	}

	function boundaryPatchFixture(state, fallbackFixture) {
		const filter = state && state.filter ? state.filter : fallbackFixture.filter;
		const vertices = Array.isArray(state && state.vertices)
			? state.vertices.map((vertex) => ({ x: finite(vertex && vertex.x), y: finite(vertex && vertex.y) }))
			: [];
		const shape = normalizeShape({
			type: 3,
			radius: finite(state && state.shapeRadius, fallbackFixture.shape.radius),
			vertices,
			hasPreviousVertex: true,
			hasNextVertex: true
		});
		return {
			shape,
			density: 0,
			friction: finite(state && state.friction, fallbackFixture.friction),
			restitution: finite(state && state.restitution, fallbackFixture.restitution),
			sensor: false,
			filter: {
				categoryBits: integer(filter && filter.categoryBits, fallbackFixture.filter.categoryBits),
				maskBits: integer(filter && filter.maskBits, fallbackFixture.filter.maskBits),
				groupIndex: integer(filter && filter.groupIndex, fallbackFixture.filter.groupIndex)
			}
		};
	}

	function staticCircleBody(circle) {
		const filter = circle && circle.filter ? circle.filter : {};
		const position = circle && circle.position ? circle.position : {};
		return {
			instanceId: integer(circle && circle.id, -1),
			objectIndex: integer(circle && circle.objectIndex, 45),
			type: 0,
			position: { x: finite(position.x), y: finite(position.y) },
			angle: finite(circle && circle.angle),
			linearVelocity: { x: 0, y: 0 },
			angularVelocity: 0,
			linearDamping: 0,
			angularDamping: 0,
			gravityScale: 1,
			sleepTime: 0,
			allowSleep: true,
			awake: true,
			active: true,
			bullet: false,
			fixedRotation: false,
			fixtures: [{
				shape: {
					type: 0,
					radius: finite(circle && circle.radius),
					center: { x: 0, y: 0 },
					vertices: [],
					previousVertex: { x: 0, y: 0 },
					nextVertex: { x: 0, y: 0 },
					hasPreviousVertex: false,
					hasNextVertex: false,
					loop: false
				},
				density: 0,
				friction: finite(circle && circle.friction, 0.2),
				restitution: finite(circle && circle.restitution),
				sensor: false,
				filter: {
					categoryBits: integer(filter.categoryBits, 1),
					maskBits: integer(filter.maskBits, 0xffff),
					groupIndex: integer(filter.groupIndex)
				}
			}]
		};
	}

	function modelFromInspection(inspection, options = {}) {
		if (!inspection || !Array.isArray(inspection.bodies)) {
			throw new Error('Compact physics inspection is invalid');
		}
		const unsupportedReasons = [];
		// Box2D body linked lists are newest-first. Reversing restores the exact
		// construction order that controls broad-phase and contact ordering.
		const bodies = inspection.bodies.slice().reverse().map(normalizeBody);
		const bodyIndexById = new Map();
		for (let index = 0; index < bodies.length; index += 1) {
			bodyIndexById.set(bodies[index].instanceId, index);
		}

		const playerId = integer(inspection.player && inspection.player.id, -1);
		const playerBodyIndex = bodyIndexById.get(playerId);
		if (!Number.isInteger(playerBodyIndex)) unsupportedReasons.push('player-body');

		const boundaryId = integer(inspection.big && inspection.big.id, -1);
		const boundaryBodyIndex = bodyIndexById.get(boundaryId);
		if (!Number.isInteger(boundaryBodyIndex)) unsupportedReasons.push('boundary-body');

		const times = Array.isArray(inspection.times) ? inspection.times : [];
		const checkpointFrames = times.map((value) =>
			value == null || !Number.isFinite(Number(value)) ? null : integer(value)
		);
		const wrapper = inspection.wrapper || {};
		const world = inspection.world || {};
		const player = inspection.player || {};
		const big = inspection.big || {};
		const model = {
			world: {
				gravity: {
					x: finite(world.gravity && world.gravity.x),
					y: finite(world.gravity && world.gravity.y, 35)
				},
				scale: finite(wrapper.scale, 0.02),
				stepRate: finite(wrapper.stepRate, 60),
				velocityIterations: integer(wrapper.velocityIterations, 10),
				positionIterations: integer(wrapper.positionIterations, 10),
				allowSleep: world.allowSleep !== false,
				warmStarting: world.warmStarting !== false,
				continuousPhysics: world.continuousPhysics !== false,
				subStepping: !!world.subStepping
			},
			player: {
				bodyIndex: Number.isInteger(playerBodyIndex) ? playerBodyIndex : -1,
				roomSpeed: finite(wrapper.roomSpeed, wrapper.stepRate || 60),
				inputScale: finite(player.inputScale, 1),
				primaryAcceleration: finite(options.primaryAcceleration, 0.52),
				secondaryAcceleration: finite(options.secondaryAcceleration, 0.01),
				secondaryAccelerationEnabled: options.secondaryAccelerationEnabled ?? !!player.extraInput,
				collectionRadiusPixels: finite(player.radius, 32.5)
			},
			lifecycle: {
				initialFrame: integer(inspection.frame),
				initialCheckpoint: integer(inspection.cp),
				initialGrowthAlarm: integer(big.growthAlarm, -1),
				initialBoundaryRadiusPixels: integer(big.radius, 200),
				maximumBoundaryRadiusPixels: integer(big.maxRadius, 1400),
				growthDelayFrames: integer(options.growthDelayFrames, 10),
				checkpointFrames
			},
			bodies,
			contacts: [],
			joints: [],
			collectibles: [],
			checkpointPatches: [],
			framePatches: [],
			growthPatches: [],
			unsupportedReasons
		};
		for (const source of inspection.contacts || []) {
			const contact = normalizeContact(source, inspection.bodies, bodyIndexById);
			if (!contact.manifold.points.length) continue;
			if (contact.bodyAIndex < 0 || contact.bodyBIndex < 0 ||
				contact.fixtureAIndex < 0 || contact.fixtureBIndex < 0) {
				unsupportedReasons.push('contact-endpoint');
				continue;
			}
			model.contacts.push(contact);
		}
		for (const source of (inspection.joints || []).slice().reverse()) {
			const joint = normalizeJoint(source, inspection.bodies, bodyIndexById);
			if (joint.type !== 1 && joint.type !== 10) unsupportedReasons.push(`joint-type:${joint.type}`);
			if (joint.bodyAIndex < 0 || joint.bodyBIndex < 0) unsupportedReasons.push('joint-body');
			model.joints.push(joint);
		}

		for (const source of inspection.collectibles || []) {
			const objectIndex = integer(source.objectIndex ?? source.type, -1);
			if (objectIndex !== 21 && objectIndex !== 23) {
				unsupportedReasons.push(`collectible-object:${objectIndex}`);
			}
			const bodyIndex = bodyIndexById.has(integer(source.id, -1))
				? bodyIndexById.get(integer(source.id, -1))
				: -1;
			const capturedRadius = source.radius == null ? NaN : Number(source.radius);
			model.collectibles.push({
				instanceId: integer(source.id, -1),
				objectIndex,
				bodyIndex,
				xPixels: finite(source.x),
				yPixels: finite(source.y),
				radiusPixels: Number.isFinite(capturedRadius) ? capturedRadius : finite(options.collectibleRadiusPixels, 24),
				active: source.active !== false,
				collected: !!source.collected,
				excluded: !!source.excluded,
				countsCheckpoint: true,
				startsGrowthAlarm: true,
				// Object 23 is collected by the level's special collector objects
				// (42/43), not by player proximity. Treating it like object 21 creates
				// false checkpoint hits when the player passes nearby.
				playerTriggered: objectIndex === 21
			});
		}

		const boundaryStates = Array.isArray(options.boundaryStates)
			? options.boundaryStates.slice().sort((left, right) => finite(left.radius) - finite(right.radius))
			: [];
		if (boundaryStates.length && Number.isInteger(boundaryBodyIndex)) {
			const boundaryBody = bodies[boundaryBodyIndex];
			const fallbackFixture = boundaryBody.fixtures[0];
			const initialRadius = integer(big.radius, 200);
			for (const state of boundaryStates) {
				const radius = integer(state && state.radius);
				if (radius <= initialRadius) continue;
				model.growthPatches.push({
					boundaryRadiusPixels: radius,
					replaceBodyIndex: boundaryBodyIndex,
					replacementFixtures: [boundaryPatchFixture(state, fallbackFixture)],
					spawnedBodies: []
				});
			}
		}

		const initialRadius = integer(big.radius, 200);
		const initialCheckpoint = integer(inspection.cp);
		const knownBodyIds = new Set(bodies.map((body) => body.instanceId));
		const framePatchFor = (frame) => {
			let patch = model.framePatches.find((candidate) => integer(candidate.frame) === frame);
			if (!patch) {
				patch = {
					frame,
					spawnedBodies: [],
					destroyedInstanceIds: [],
					bodyUpdates: [],
					bodyStateUpdates: [],
					contacts: [],
					spawnedJoints: [],
					destroyedJoints: []
				};
				model.framePatches.push(patch);
			}
			return patch;
		};
		const bodySpawnEvents = Array.isArray(options.bodySpawnEvents)
			? options.bodySpawnEvents.slice().sort((left, right) => integer(left && left.frame) - integer(right && right.frame))
			: [];
		for (const event of bodySpawnEvents) {
			const spawnedBodies = [];
			for (const source of event && Array.isArray(event.bodies) ? event.bodies : []) {
				const body = normalizeBody(source);
				if (knownBodyIds.has(body.instanceId)) continue;
				knownBodyIds.add(body.instanceId);
				spawnedBodies.push(body);
			}
			if (!spawnedBodies.length) continue;

			const contactFrame = integer(event && event.frame, -1);
			for (const source of event && Array.isArray(event.contacts) ? event.contacts : []) {
				const contact = normalizeInstanceContact(source);
				if (
					contactFrame < integer(inspection.frame) ||
					!knownBodyIds.has(contact.bodyAInstanceId) ||
					!knownBodyIds.has(contact.bodyBInstanceId) ||
					contact.fixtureAIndex < 0 ||
					contact.fixtureBIndex < 0 ||
					!contact.manifold.points.length
				) continue;
				framePatchFor(contactFrame).contacts.push(contact);
			}

			const radius = integer(event && event.boundaryRadius, initialRadius);
			const growthAlarm = integer(event && event.growthAlarm, -1);
			if (growthAlarm === 0 && radius > initialRadius) {
				const growthPatch = model.growthPatches.find(
					(patch) => integer(patch.boundaryRadiusPixels) === radius
				);
				if (!growthPatch) {
					unsupportedReasons.push(`spawn-growth-radius:${radius}`);
					continue;
				}
				growthPatch.spawnedBodies.push(...spawnedBodies);
				continue;
			}

			const checkpoint = integer(event && event.checkpoint, initialCheckpoint);
			if (checkpoint > initialCheckpoint) {
				let checkpointPatch = model.checkpointPatches.find(
					(patch) => integer(patch.checkpoint) === checkpoint
				);
				if (!checkpointPatch) {
					checkpointPatch = { checkpoint, spawnedBodies: [] };
					model.checkpointPatches.push(checkpointPatch);
				}
				checkpointPatch.spawnedBodies.push(...spawnedBodies);
				continue;
			}

			if (radius > initialRadius) {
				const growthPatch = model.growthPatches.find(
					(patch) => integer(patch.boundaryRadiusPixels) === radius
				);
				if (!growthPatch) {
					unsupportedReasons.push(`spawn-growth-radius:${radius}`);
					continue;
				}
				growthPatch.spawnedBodies.push(...spawnedBodies);
				continue;
			}

			const frame = integer(event && event.frame, -2) + (event && event.exactFrame ? 0 : 1);
			if (frame >= integer(inspection.frame)) {
				framePatchFor(frame).spawnedBodies.push(...spawnedBodies);
				continue;
			}

			unsupportedReasons.push(`spawn-frame:${frame}`);
		}
		const bodyDestroyEvents = Array.isArray(options.bodyDestroyEvents)
			? options.bodyDestroyEvents.slice().sort((left, right) => integer(left && left.frame) - integer(right && right.frame))
			: [];
		for (const event of bodyDestroyEvents) {
			const frame = integer(event && event.frame, -2) + 1;
			if (frame < integer(inspection.frame)) {
				unsupportedReasons.push(`destroy-frame:${frame}`);
				continue;
			}
			const ids = Array.isArray(event && event.instanceIds)
				? event.instanceIds.map((value) => integer(value, -1)).filter((value) => value >= 0)
				: [];
			framePatchFor(frame).destroyedInstanceIds.push(...ids);
		}
		const bodyUpdateEvents = Array.isArray(options.bodyUpdateEvents)
			? options.bodyUpdateEvents.slice().sort(
				(left, right) => integer(left && left.frame) - integer(right && right.frame)
			)
			: [];
		for (const event of bodyUpdateEvents) {
			const frame = integer(event && event.frame, -1);
			if (frame < integer(inspection.frame)) {
				unsupportedReasons.push(`body-update-frame:${frame}`);
				continue;
			}
			for (const source of event && Array.isArray(event.updates) ? event.updates : []) {
				const instanceId = integer(source && source.instanceId, -1);
				if (instanceId < 0 || !knownBodyIds.has(instanceId)) continue;
				framePatchFor(frame).bodyUpdates.push({
					instanceId,
					type: integer(source && source.type),
					linearDamping: finite(source && source.linearDamping),
					angularDamping: finite(source && source.angularDamping),
					gravityScale: finite(source && source.gravityScale, 1),
					allowSleep: source && source.allowSleep !== false,
					awake: source && source.awake !== false,
					active: source && source.active !== false,
					bullet: !!(source && source.bullet),
					fixedRotation: !!(source && source.fixedRotation)
				});
			}
		}
		const jointSpawnEvents = Array.isArray(options.jointSpawnEvents)
			? options.jointSpawnEvents.slice().sort(
				(left, right) => integer(left && left.frame) - integer(right && right.frame)
			)
			: [];
		for (const event of jointSpawnEvents) {
			const frame = integer(event && event.frame, -1);
			if (frame < integer(inspection.frame)) {
				unsupportedReasons.push(`joint-spawn-frame:${frame}`);
				continue;
			}
			for (const source of event && Array.isArray(event.joints) ? event.joints : []) {
				const joint = normalizeInstanceJoint(source);
				if (joint.type !== 1 && joint.type !== 10) {
					unsupportedReasons.push(`joint-type:${joint.type}`);
					continue;
				}
				if (
					!knownBodyIds.has(joint.bodyAInstanceId) ||
					!knownBodyIds.has(joint.bodyBInstanceId)
				) {
					unsupportedReasons.push('joint-spawn-body');
					continue;
				}
				framePatchFor(frame).spawnedJoints.push(joint);
			}
			for (const source of event && Array.isArray(event.bodyStates) ? event.bodyStates : []) {
				const instanceId = integer(source && source.instanceId, -1);
				if (instanceId < 0 || !knownBodyIds.has(instanceId)) continue;
				framePatchFor(frame).bodyStateUpdates.push({
					instanceId,
					position: {
						x: Number(source && source.x),
						y: Number(source && source.y)
					},
					angle: Number(source && source.angle),
					linearVelocity: {
						x: Number(source && source.vx),
						y: Number(source && source.vy)
					},
					angularVelocity: Number(source && source.angularVelocity),
					sleepTime: Number(source && source.sleepTime)
				});
			}
		}
		const jointDestroyEvents = Array.isArray(options.jointDestroyEvents)
			? options.jointDestroyEvents.slice().sort(
				(left, right) => integer(left && left.frame) - integer(right && right.frame)
			)
			: [];
		for (const event of jointDestroyEvents) {
			const frame = integer(event && event.frame, -1);
			if (frame < integer(inspection.frame)) {
				unsupportedReasons.push(`joint-destroy-frame:${frame}`);
				continue;
			}
			for (const source of event && Array.isArray(event.joints) ? event.joints : []) {
				framePatchFor(frame).destroyedJoints.push({
					type: integer(source && source.type, -1),
					bodyAInstanceId: integer(source && source.bodyAId, -1),
					bodyBInstanceId: integer(source && source.bodyBId, -1)
				});
			}
		}
		model.checkpointPatches.sort((left, right) => integer(left.checkpoint) - integer(right.checkpoint));
		model.framePatches.sort((left, right) => integer(left.frame) - integer(right.frame));

		return model;
	}

	async function create(url = DEFAULT_URL) {
		const response = await fetch(url, { cache: 'force-cache' });
		if (!response.ok) throw new Error(`Wasm fetch failed (${response.status})`);
		const bytes = await response.arrayBuffer();
		const importCalls = { fd_close: 0, fd_seek: 0, fd_write: 0 };
		const failDescriptor = (name) => {
			importCalls[name] += 1;
			return 8;
		};
		const instantiated = await WebAssembly.instantiate(bytes, {
			circloo_math: {
				sin: Math.sin,
				cos: Math.cos
			},
			wasi_snapshot_preview1: {
				fd_close: () => failDescriptor('fd_close'),
				fd_seek: () => failDescriptor('fd_seek'),
				fd_write: () => failDescriptor('fd_write')
			}
		});
		const instance = instantiated.instance || instantiated;
		const exports = instance.exports;
		const memory = exports.memory;
		if (!(memory instanceof WebAssembly.Memory)) throw new Error('Wasm memory is unavailable');

		const abi = {
			inputPtr: requireExport(exports, 'circloo_input_ptr')(),
			inputCapacity: requireExport(exports, 'circloo_input_capacity')(),
			vertexPtr: requireExport(exports, 'circloo_vertex_ptr')(),
			vertexCapacity: requireExport(exports, 'circloo_vertex_capacity')(),
			resultPtr: requireExport(exports, 'circloo_result_ptr')(),
			resultSize: requireExport(exports, 'circloo_result_size')(),
			bodyStatePtr: requireExport(exports, 'circloo_body_state_ptr')(),
			bodyStateCount: requireExport(exports, 'circloo_body_state_count'),
			bodyStateCapacity: requireExport(exports, 'circloo_body_state_capacity')(),
			bodyStateStride: requireExport(exports, 'circloo_body_state_stride')(),
			jointStatePtr: requireExport(exports, 'circloo_joint_state_ptr')(),
			jointStateCount: requireExport(exports, 'circloo_joint_state_count'),
			jointStateCapacity: requireExport(exports, 'circloo_joint_state_capacity')(),
			jointStateStride: requireExport(exports, 'circloo_joint_state_stride')(),
			debugInitialFrame: requireExport(exports, 'circloo_model_debug_initial_frame'),
			debugFramePatchCount: requireExport(exports, 'circloo_model_debug_frame_patch_count'),
			debugFramePatchFrame: requireExport(exports, 'circloo_model_debug_frame_patch_frame'),
			reset: requireExport(exports, 'circloo_model_reset'),
			setWorld: requireExport(exports, 'circloo_model_set_world'),
			setLifecycle: requireExport(exports, 'circloo_model_set_lifecycle'),
			setCheckpointFrame: requireExport(exports, 'circloo_model_set_checkpoint_frame'),
			addPatch: requireExport(exports, 'circloo_model_add_patch'),
			addCheckpointPatch: requireExport(exports, 'circloo_model_add_checkpoint_patch'),
			addFramePatch: requireExport(exports, 'circloo_model_add_frame_patch'),
			addFramePatchDestroy: requireExport(exports, 'circloo_model_add_frame_patch_destroy'),
			addFramePatchBodyUpdate: requireExport(exports, 'circloo_model_add_frame_patch_body_update'),
			addFramePatchBodyState: requireExport(exports, 'circloo_model_add_frame_patch_body_state'),
			addFramePatchContact: requireExport(exports, 'circloo_model_add_frame_patch_contact'),
			addFramePatchJoint: requireExport(exports, 'circloo_model_add_frame_patch_joint'),
			addFramePatchJointDestroy: requireExport(exports, 'circloo_model_add_frame_patch_joint_destroy'),
			addBody: requireExport(exports, 'circloo_model_add_body'),
			addJoint: requireExport(exports, 'circloo_model_add_joint'),
			addContact: requireExport(exports, 'circloo_model_add_contact'),
			setPlayer: requireExport(exports, 'circloo_model_set_player'),
			addCircle: requireExport(exports, 'circloo_model_add_circle_fixture'),
			addPolygon: requireExport(exports, 'circloo_model_add_polygon_fixture'),
			addEdge: requireExport(exports, 'circloo_model_add_edge_fixture'),
			addChain: requireExport(exports, 'circloo_model_add_chain_fixture'),
			addCollectible: requireExport(exports, 'circloo_model_add_collectible'),
			finalize: requireExport(exports, 'circloo_model_finalize'),
			simulate: requireExport(exports, 'circloo_simulate'),
			sequenceBegin: requireExport(exports, 'circloo_sequence_begin'),
			sequenceStep: requireExport(exports, 'circloo_sequence_step'),
			sequenceEnd: requireExport(exports, 'circloo_sequence_end'),
			selfTest: requireExport(exports, 'circloo_reference_self_test')
		};

		if (abi.resultSize !== 96) throw new Error(`Unexpected result size ${abi.resultSize}`);
		if (abi.bodyStateStride !== 120) throw new Error(`Unexpected body-state stride ${abi.bodyStateStride}`);
		if (abi.jointStateStride !== 48) throw new Error(`Unexpected joint-state stride ${abi.jointStateStride}`);
		if (abi.selfTest() !== 1) throw new Error('Wasm reference self-test failed');
		if (Object.values(importCalls).some((count) => count !== 0)) {
			throw new Error(`Wasm used compatibility imports: ${JSON.stringify(importCalls)}`);
		}

		function uploadVertices(vertices) {
			const values = Array.isArray(vertices) ? vertices : [];
			if (values.length > abi.vertexCapacity) {
				throw new Error(`Vertex capacity exceeded (${values.length} > ${abi.vertexCapacity})`);
			}
			const view = new Float64Array(memory.buffer, abi.vertexPtr, values.length * 2);
			for (let index = 0; index < values.length; index += 1) {
				view[index * 2] = finite(values[index] && values[index].x);
				view[index * 2 + 1] = finite(values[index] && values[index].y);
			}
		}

		function addFixture(targetType, targetIndex, fixture) {
			const shape = fixture && fixture.shape;
			if (!shape) throw new Error('Fixture shape is missing');
			const filter = fixture.filter || {};
			const common = [
				finite(fixture.density),
				finite(fixture.friction, 0.2),
				finite(fixture.restitution),
				fixtureFlags(fixture),
				integer(filter.categoryBits, 1),
				integer(filter.maskBits, 0xffff),
				integer(filter.groupIndex)
			];
			const type = integer(shape.type, -1);
			let accepted = 0;
			if (type === 0) {
				accepted = abi.addCircle(
					targetType,
					targetIndex,
					finite(shape.radius),
					finite(shape.center && shape.center.x),
					finite(shape.center && shape.center.y),
					...common
				);
			} else if (type === 1) {
				uploadVertices(shape.vertices);
				accepted = abi.addEdge(
					targetType,
					targetIndex,
					finite(shape.radius, 0.01),
					shape.hasPreviousVertex ? 1 : 0,
					finite(shape.previousVertex && shape.previousVertex.x),
					finite(shape.previousVertex && shape.previousVertex.y),
					shape.hasNextVertex ? 1 : 0,
					finite(shape.nextVertex && shape.nextVertex.x),
					finite(shape.nextVertex && shape.nextVertex.y),
					...common
				);
			} else if (type === 2) {
				uploadVertices(shape.vertices);
				accepted = abi.addPolygon(
					targetType,
					targetIndex,
					shape.vertices.length,
					finite(shape.radius, 0.01),
					...common
				);
			} else if (type === 3) {
				uploadVertices(shape.vertices);
				accepted = abi.addChain(
					targetType,
					targetIndex,
					shape.vertices.length,
					finite(shape.radius, 0.01),
					shape.loop ? 1 : 0,
					shape.hasPreviousVertex ? 1 : 0,
					finite(shape.previousVertex && shape.previousVertex.x),
					finite(shape.previousVertex && shape.previousVertex.y),
					shape.hasNextVertex ? 1 : 0,
					finite(shape.nextVertex && shape.nextVertex.x),
					finite(shape.nextVertex && shape.nextVertex.y),
					...common
				);
			} else {
				throw new Error(`Unsupported shape type ${type}`);
			}
			if (accepted !== 1) throw new Error(`Wasm rejected shape type ${type}`);
		}

		function addBody(body, patchIndex = -1) {
			const position = body.position || {};
			const velocity = body.linearVelocity || {};
			const localCenter = body.localCenter || {};
			const handle = abi.addBody(
				patchIndex,
				integer(body.instanceId, -1),
				integer(body.objectIndex, -1),
				integer(body.type),
				finite(position.x),
				finite(position.y),
				finite(body.angle),
				finite(velocity.x),
				finite(velocity.y),
				finite(body.angularVelocity),
				finite(body.linearDamping),
				finite(body.angularDamping),
				finite(body.gravityScale, 1),
				finite(body.sleepTime),
				finite(body.mass),
				finite(body.inverseMass),
				finite(body.inertia),
				finite(body.inverseInertia),
				finite(localCenter.x),
				finite(localCenter.y),
				body.hasCapturedMassState ? 1 : 0,
				bodyFlags(body)
			);
			if (handle < 0) throw new Error('Wasm rejected body');
			for (const fixture of body.fixtures || []) addFixture(0, handle, fixture);
			return handle;
		}

		function loadModel(model) {
			if (!model || !Array.isArray(model.bodies)) throw new Error('Invalid runtime model');
			abi.reset();
			const world = model.world || {};
			const gravity = world.gravity || {};
			abi.setWorld(
				finite(gravity.x),
				finite(gravity.y, 35),
				finite(world.scale, 0.02),
				finite(world.stepRate, 60),
				integer(world.velocityIterations, 10),
				integer(world.positionIterations, 10),
				worldFlags(world)
			);

			const lifecycle = model.lifecycle || {};
			abi.setLifecycle(
				integer(lifecycle.initialFrame),
				integer(lifecycle.initialCheckpoint),
				integer(lifecycle.initialGrowthAlarm, -1),
				integer(lifecycle.initialBoundaryRadiusPixels, 200),
				integer(lifecycle.maximumBoundaryRadiusPixels, 1400),
				integer(lifecycle.growthDelayFrames, 10)
			);
			for (let checkpoint = 0; checkpoint < (lifecycle.checkpointFrames || []).length; checkpoint += 1) {
				const frame = lifecycle.checkpointFrames[checkpoint];
				if (frame != null && Number.isFinite(Number(frame))) {
					abi.setCheckpointFrame(checkpoint, integer(frame));
				}
			}

			const bodyHandles = model.bodies.map((body) => addBody(body));
			for (const contact of model.contacts || []) {
				const points = contact.manifold && Array.isArray(contact.manifold.points)
					? contact.manifold.points.slice(0, 2)
					: [];
				if (!points.length) continue;
				const point0 = points[0] || {};
				const point1 = points[1] || {};
				const bodyAHandle = bodyHandles[integer(contact.bodyAIndex, -1)];
				const bodyBHandle = bodyHandles[integer(contact.bodyBIndex, -1)];
				if (!Number.isInteger(bodyAHandle) || !Number.isInteger(bodyBHandle) || abi.addContact(
					bodyAHandle,
					integer(contact.fixtureAIndex, -1),
					integer(contact.childA),
					bodyBHandle,
					integer(contact.fixtureBIndex, -1),
					integer(contact.childB),
					integer(contact.flags),
					finite(contact.friction),
					finite(contact.restitution),
					finite(contact.tangentSpeed),
					integer(contact.toiCount),
					finite(contact.toi, 1),
					points.length,
					finite(point0.localPoint && point0.localPoint.x),
					finite(point0.localPoint && point0.localPoint.y),
					finite(point0.normalImpulse),
					finite(point0.tangentImpulse),
					integer(point0.id),
					finite(point1.localPoint && point1.localPoint.x),
					finite(point1.localPoint && point1.localPoint.y),
					finite(point1.normalImpulse),
					finite(point1.tangentImpulse),
					integer(point1.id)
				) !== 1) throw new Error('Wasm rejected contact');
			}
			for (const joint of model.joints || []) {
				const bodyAHandle = bodyHandles[integer(joint.bodyAIndex, -1)];
				const bodyBHandle = bodyHandles[integer(joint.bodyBIndex, -1)];
				const flags = bit(!!joint.collideConnected, 1) |
					bit(!!joint.enableLimit, 2) |
					bit(!!joint.enableMotor, 4);
				if (!Number.isInteger(bodyAHandle) || !Number.isInteger(bodyBHandle) || abi.addJoint(
					integer(joint.type, -1),
					bodyAHandle,
					bodyBHandle,
					finite(joint.anchorA && joint.anchorA.x),
					finite(joint.anchorA && joint.anchorA.y),
					finite(joint.anchorB && joint.anchorB.x),
					finite(joint.anchorB && joint.anchorB.y),
					finite(joint.localAnchorA && joint.localAnchorA.x),
					finite(joint.localAnchorA && joint.localAnchorA.y),
					finite(joint.localAnchorB && joint.localAnchorB.x),
					finite(joint.localAnchorB && joint.localAnchorB.y),
					finite(joint.referenceAngle),
					finite(joint.lowerAngle),
					finite(joint.upperAngle),
					finite(joint.maxMotorTorque),
					finite(joint.motorSpeed),
					finite(joint.maxLength),
					finite(joint.impulse && joint.impulse.x),
					finite(joint.impulse && joint.impulse.y),
					finite(joint.impulse && joint.impulse.z),
					finite(joint.motorImpulse),
					integer(joint.limitState),
					flags
				) !== 1) throw new Error('Wasm rejected joint');
			}
			const player = model.player || {};
			const playerHandle = bodyHandles[integer(player.bodyIndex, -1)];
			if (!Number.isInteger(playerHandle) || abi.setPlayer(
				playerHandle,
				finite(player.roomSpeed, world.stepRate || 60),
				finite(player.inputScale, 1),
				finite(player.primaryAcceleration, 0.52),
				finite(player.secondaryAcceleration, 0.01),
				player.secondaryAccelerationEnabled === false ? 0 : 1,
				finite(player.collectionRadiusPixels, 32.5)
			) !== 1) throw new Error('Wasm rejected player rules');

			for (const collectible of model.collectibles || []) {
				const bodyHandle = integer(collectible.bodyIndex, -1) >= 0
					? bodyHandles[integer(collectible.bodyIndex)]
					: -1;
				if (abi.addCollectible(
					integer(collectible.instanceId, -1),
					integer(collectible.objectIndex, -1),
					Number.isInteger(bodyHandle) ? bodyHandle : -1,
					finite(collectible.xPixels),
					finite(collectible.yPixels),
					finite(collectible.radiusPixels, 24),
					collectibleFlags(collectible)
				) !== 1) throw new Error('Wasm rejected collectible');
			}

			for (const patch of model.checkpointPatches || []) {
				const patchIndex = abi.addCheckpointPatch(integer(patch.checkpoint));
				if (patchIndex < 0) throw new Error('Wasm rejected checkpoint patch');
				const encodedTarget = -patchIndex - 2;
				for (const body of patch.spawnedBodies || []) addBody(body, encodedTarget);
			}

			for (const patch of model.framePatches || []) {
				const encodedTarget = abi.addFramePatch(integer(patch.frame));
				if (encodedTarget === 0) throw new Error('Wasm rejected frame patch');
				for (const instanceId of patch.destroyedInstanceIds || []) {
					if (abi.addFramePatchDestroy(encodedTarget, integer(instanceId, -1)) !== 1) {
						throw new Error('Wasm rejected frame-patch body destruction');
					}
				}
				for (const body of patch.spawnedBodies || []) addBody(body, encodedTarget);
				for (const joint of patch.destroyedJoints || []) {
					if (abi.addFramePatchJointDestroy(
						encodedTarget,
						integer(joint.type, -1),
						integer(joint.bodyAInstanceId, -1),
						integer(joint.bodyBInstanceId, -1)
					) !== 1) throw new Error('Wasm rejected frame joint destruction');
				}
				for (const joint of patch.spawnedJoints || []) {
					let flags = 0;
					if (joint.collideConnected) flags |= 1;
					if (joint.enableLimit) flags |= 2;
					if (joint.enableMotor) flags |= 4;
					if (abi.addFramePatchJoint(
						encodedTarget,
						integer(joint.type, -1),
						integer(joint.bodyAInstanceId, -1),
						integer(joint.bodyBInstanceId, -1),
						finite(joint.anchorA && joint.anchorA.x),
						finite(joint.anchorA && joint.anchorA.y),
						finite(joint.anchorB && joint.anchorB.x),
						finite(joint.anchorB && joint.anchorB.y),
						finite(joint.localAnchorA && joint.localAnchorA.x),
						finite(joint.localAnchorA && joint.localAnchorA.y),
						finite(joint.localAnchorB && joint.localAnchorB.x),
						finite(joint.localAnchorB && joint.localAnchorB.y),
						finite(joint.referenceAngle),
						finite(joint.lowerAngle),
						finite(joint.upperAngle),
						finite(joint.maxMotorTorque),
						finite(joint.motorSpeed),
						finite(joint.maxLength),
						finite(joint.impulse && joint.impulse.x),
						finite(joint.impulse && joint.impulse.y),
						finite(joint.impulse && joint.impulse.z),
						finite(joint.motorImpulse),
						integer(joint.limitState),
						flags
					) !== 1) throw new Error('Wasm rejected frame joint');
				}
				for (const update of patch.bodyStateUpdates || []) {
					if (abi.addFramePatchBodyState(
						encodedTarget,
						integer(update.instanceId, -1),
						Number(update.position && update.position.x),
						Number(update.position && update.position.y),
						Number(update.angle),
						Number(update.linearVelocity && update.linearVelocity.x),
						Number(update.linearVelocity && update.linearVelocity.y),
						Number(update.angularVelocity),
						Number(update.sleepTime)
					) !== 1) throw new Error('Wasm rejected frame body state');
				}
				for (const update of patch.bodyUpdates || []) {
					if (abi.addFramePatchBodyUpdate(
						encodedTarget,
						integer(update.instanceId, -1),
						integer(update.type),
						finite(update.linearDamping),
						finite(update.angularDamping),
						finite(update.gravityScale, 1),
						bodyFlags(update)
					) !== 1) throw new Error('Wasm rejected frame body update');
				}
				for (const contact of patch.contacts || []) {
					const points = contact.manifold && Array.isArray(contact.manifold.points)
						? contact.manifold.points.slice(0, 2)
						: [];
					if (!points.length) continue;
					const point0 = points[0] || {};
					const point1 = points[1] || {};
					if (abi.addFramePatchContact(
						encodedTarget,
						integer(contact.bodyAInstanceId, -1),
						integer(contact.fixtureAIndex, -1),
						integer(contact.childA),
						integer(contact.bodyBInstanceId, -1),
						integer(contact.fixtureBIndex, -1),
						integer(contact.childB),
						integer(contact.flags),
						finite(contact.friction),
						finite(contact.restitution),
						finite(contact.tangentSpeed),
						integer(contact.toiCount),
						finite(contact.toi, 1),
						points.length,
						finite(point0.localPoint && point0.localPoint.x),
						finite(point0.localPoint && point0.localPoint.y),
						finite(point0.normalImpulse),
						finite(point0.tangentImpulse),
						integer(point0.id),
						finite(point1.localPoint && point1.localPoint.x),
						finite(point1.localPoint && point1.localPoint.y),
						finite(point1.normalImpulse),
						finite(point1.tangentImpulse),
						integer(point1.id)
					) !== 1) throw new Error('Wasm rejected frame contact');
				}
			}

			for (const patch of model.growthPatches || []) {
				const replaceHandle = integer(patch.replaceBodyIndex, -1) >= 0
					? bodyHandles[integer(patch.replaceBodyIndex)]
					: -1;
				const patchIndex = abi.addPatch(
					integer(patch.boundaryRadiusPixels),
					Number.isInteger(replaceHandle) ? replaceHandle : -1
				);
				if (patchIndex < 0) throw new Error('Wasm rejected growth patch');
				for (const fixture of patch.replacementFixtures || []) addFixture(1, patchIndex, fixture);
				for (const body of patch.spawnedBodies || []) addBody(body, patchIndex);
			}

			if (abi.finalize() !== 1) throw new Error('Wasm rejected finalized model');
			const framePatchCount = abi.debugFramePatchCount();
			const framePatches = [];
			for (let index = 0; index < framePatchCount; index += 1) {
				framePatches.push(abi.debugFramePatchFrame(index));
			}
			return {
				bodyCount: bodyHandles.length,
				initialFrame: abi.debugInitialFrame(),
				framePatches
			};
		}

		function readResult(status, includePhysics = true) {
			const view = new DataView(memory.buffer, abi.resultPtr, abi.resultSize);
			const checkpoint = view.getInt32(4, true);
			const checkpointFrames = [];
			for (let index = 0; index < 8; index += 1) {
				checkpointFrames.push(view.getInt32(16 + index * 4, true));
			}
			const bodyStateCount = includePhysics
				? Math.min(abi.bodyStateCapacity, Math.max(0, abi.bodyStateCount()))
				: 0;
			const bodyStates = [];
			const bodyView = new DataView(
				memory.buffer,
				abi.bodyStatePtr,
				bodyStateCount * abi.bodyStateStride
			);
			for (let index = 0; index < bodyStateCount; index += 1) {
				const offset = index * abi.bodyStateStride;
				bodyStates.push({
					ordinal: index,
					instanceId: bodyView.getInt32(offset, true),
					objectIndex: bodyView.getInt32(offset + 4, true),
					type: bodyView.getInt32(offset + 8, true),
					flags: bodyView.getInt32(offset + 12, true),
					x: bodyView.getFloat64(offset + 16, true),
					y: bodyView.getFloat64(offset + 24, true),
					vx: bodyView.getFloat64(offset + 32, true),
					vy: bodyView.getFloat64(offset + 40, true),
					angle: bodyView.getFloat64(offset + 48, true),
					angularVelocity: bodyView.getFloat64(offset + 56, true),
					sleepTime: bodyView.getFloat64(offset + 64, true),
					mass: bodyView.getFloat64(offset + 72, true),
					inverseMass: bodyView.getFloat64(offset + 80, true),
					inertia: bodyView.getFloat64(offset + 88, true),
					inverseInertia: bodyView.getFloat64(offset + 96, true),
					localCenterX: bodyView.getFloat64(offset + 104, true),
					localCenterY: bodyView.getFloat64(offset + 112, true)
				});
			}
			const jointStateCount = includePhysics
				? Math.min(abi.jointStateCapacity, Math.max(0, abi.jointStateCount()))
				: 0;
			const jointStates = [];
			const jointView = new DataView(
				memory.buffer,
				abi.jointStatePtr,
				jointStateCount * abi.jointStateStride
			);
			for (let index = 0; index < jointStateCount; index += 1) {
				const offset = index * abi.jointStateStride;
				jointStates.push({
					type: jointView.getInt32(offset, true),
					bodyAId: jointView.getInt32(offset + 4, true),
					bodyBId: jointView.getInt32(offset + 8, true),
					limitState: jointView.getInt32(offset + 12, true),
					impulseX: jointView.getFloat64(offset + 16, true),
					impulseY: jointView.getFloat64(offset + 24, true),
					impulseZ: jointView.getFloat64(offset + 32, true),
					motorImpulse: jointView.getFloat64(offset + 40, true)
				});
			}
			return {
				status,
				reached: status === 1,
				frame: view.getInt32(0, true),
				checkpoint,
				growthAlarm: view.getInt32(8, true),
				boundaryRadiusPixels: view.getInt32(12, true),
				checkpointFrames,
				x: view.getFloat64(48, true),
				y: view.getFloat64(56, true),
				vx: view.getFloat64(64, true),
				vy: view.getFloat64(72, true),
				angle: view.getFloat64(80, true),
				angularVelocity: view.getFloat64(88, true),
				bodyStates,
				jointStates
			};
		}

		function simulate(inputs, finishCheckpoint = 7) {
			const values = inputs instanceof Uint8Array ? inputs : Uint8Array.from(inputs || []);
			if (values.length > abi.inputCapacity) {
				throw new Error(`Input capacity exceeded (${values.length} > ${abi.inputCapacity})`);
			}
			new Uint8Array(memory.buffer, abi.inputPtr, values.length).set(values);
			return readResult(abi.simulate(values.length, integer(finishCheckpoint, 7)));
		}

		function beginSequence(includePhysics = true) {
			if (abi.sequenceBegin() !== 1) throw new Error('Wasm sequence initialization failed');
			return readResult(0, includePhysics);
		}

		function stepSequence(input, finishCheckpoint = 7, includePhysics = true) {
			return readResult(
				abi.sequenceStep(integer(input) & 3, integer(finishCheckpoint, 7)),
				includePhysics
			);
		}

		function endSequence() {
			abi.sequenceEnd();
		}

		return {
			instance,
			exports,
			memory,
			importCalls,
			loadModel,
			simulate,
			beginSequence,
			stepSequence,
			endSequence
		};
	}

	scope.CirclooWasmRuntime = Object.freeze({ create, modelFromInspection });
})(typeof self !== 'undefined' ? self : globalThis);
