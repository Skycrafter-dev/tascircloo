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
			bit(collectible.startsGrowthAlarm !== false, 16)
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
		if (Array.isArray(inspection.joints) && inspection.joints.length) {
			unsupportedReasons.push(`joints:${inspection.joints.length}`);
		}

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
			collectibles: [],
			growthPatches: [],
			unsupportedReasons
		};

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
				startsGrowthAlarm: true
			});
		}

		const boundaryStates = Array.isArray(options.boundaryStates)
			? options.boundaryStates.slice().sort((left, right) => finite(left.radius) - finite(right.radius))
			: [];
		if (boundaryStates.length && Number.isInteger(boundaryBodyIndex)) {
			const boundaryBody = bodies[boundaryBodyIndex];
			const fallbackFixture = boundaryBody.fixtures[0];
			const initialRadius = integer(big.radius, 200);
			const knownBodyIds = new Set(bodies.map((body) => body.instanceId));
			for (const state of boundaryStates) {
				const radius = integer(state && state.radius);
				if (radius <= initialRadius) {
					for (const circle of state.staticCircles || []) knownBodyIds.add(integer(circle.id, -1));
					continue;
				}
				const spawnedBodies = [];
				for (const circle of state.staticCircles || []) {
					const id = integer(circle.id, -1);
					if (knownBodyIds.has(id)) continue;
					knownBodyIds.add(id);
					spawnedBodies.push(staticCircleBody(circle));
				}
				model.growthPatches.push({
					boundaryRadiusPixels: radius,
					replaceBodyIndex: boundaryBodyIndex,
					replacementFixtures: [boundaryPatchFixture(state, fallbackFixture)],
					spawnedBodies
				});
			}
		}

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
			reset: requireExport(exports, 'circloo_model_reset'),
			setWorld: requireExport(exports, 'circloo_model_set_world'),
			setLifecycle: requireExport(exports, 'circloo_model_set_lifecycle'),
			setCheckpointFrame: requireExport(exports, 'circloo_model_set_checkpoint_frame'),
			addPatch: requireExport(exports, 'circloo_model_add_patch'),
			addBody: requireExport(exports, 'circloo_model_add_body'),
			setPlayer: requireExport(exports, 'circloo_model_set_player'),
			addCircle: requireExport(exports, 'circloo_model_add_circle_fixture'),
			addPolygon: requireExport(exports, 'circloo_model_add_polygon_fixture'),
			addEdge: requireExport(exports, 'circloo_model_add_edge_fixture'),
			addChain: requireExport(exports, 'circloo_model_add_chain_fixture'),
			addCollectible: requireExport(exports, 'circloo_model_add_collectible'),
			finalize: requireExport(exports, 'circloo_model_finalize'),
			simulate: requireExport(exports, 'circloo_simulate'),
			selfTest: requireExport(exports, 'circloo_reference_self_test')
		};

		if (abi.resultSize !== 96) throw new Error(`Unexpected result size ${abi.resultSize}`);
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
			return { bodyCount: bodyHandles.length };
		}

		function readResult(status) {
			const view = new DataView(memory.buffer, abi.resultPtr, abi.resultSize);
			const checkpoint = view.getInt32(4, true);
			const checkpointFrames = [];
			for (let index = 0; index < 8; index += 1) {
				checkpointFrames.push(view.getInt32(16 + index * 4, true));
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
				angularVelocity: view.getFloat64(88, true)
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

		return {
			instance,
			exports,
			memory,
			importCalls,
			loadModel,
			simulate
		};
	}

	scope.CirclooWasmRuntime = Object.freeze({ create, modelFromInspection });
})(typeof self !== 'undefined' ? self : globalThis);
