import createSteamAudioModule from './bindings/phonon_bindings.js'

let runtime
const meshes = new Map()
const pendingMeshReleases = []
const sources = new Map()

const allocate = (module, byteLength) => {
  const pointer = module._malloc(byteLength)
  if (!pointer)
    throw new Error(`Steam Audio reflection worker could not allocate ${byteLength} bytes`)
  return pointer
}

const createHandle = (module, create) => {
  const out = allocate(module, 4)
  try {
    module.HEAPU32[out >>> 2] = 0
    const status = create(out)
    if (status !== 0)
      throw new Error(`Steam Audio reflection worker failed with status ${status}`)
    const handle = module.HEAPU32[out >>> 2]
    if (!handle)
      throw new Error('Steam Audio reflection worker returned a null handle')
    return handle
  }
  finally {
    module._free(out)
  }
}

const withArray = (module, heap, values, callback) => {
  const pointer = allocate(module, values.length * 4)
  try {
    heap.set(values, pointer >>> 2)
    return callback(pointer)
  }
  finally {
    module._free(pointer)
  }
}

const createStaticMesh = (scene, geometry, materialCount) => {
  const { module } = runtime
  return createHandle(module, out =>
    withArray(module, module.HEAPF32, geometry.vertices, vertices =>
      withArray(module, module.HEAP32, geometry.indices, indices =>
        withArray(module, module.HEAPF32, geometry.absorption, absorption =>
          withArray(module, module.HEAPF32, geometry.scattering, scattering =>
            withArray(module, module.HEAPF32, geometry.transmission, transmission =>
              withArray(module, module.HEAP32, geometry.materialIndices, materialIndices =>
                module._sa_static_mesh_create(
                  scene,
                  geometry.vertices.length / 3,
                  vertices,
                  geometry.indices.length / 3,
                  indices,
                  materialCount,
                  absorption,
                  scattering,
                  transmission,
                  materialIndices,
                  out,
                ))))))))
}

// Extract the source's RAW, listener-relative Ambisonic reflection impulse
// response taps (channels x samples, channel-major) and ship them unmodified.
//
// The convolution + head-tracked Ambisonics->binaural decode NO LONGER happen
// here. Instead the AudioWorklet re-partitions these taps into Steam's own
// overlap-save convolver and runs it against the live dry send, then decodes to
// binaural with the LIVE head orientation every block. Keeping a persistent
// convolver in the worklet (state carried across sim updates) is what removes
// the old ConvolverNode-swap ~10Hz beat.
//
// sa_simulator_run_reflections must have run immediately before (see `run`),
// which populates the source's internal ImpulseResponse; sa_source_get_reflection_ir
// then copies those raw taps out.
// Output: channel-major Float32Array [ch0(0..N-1), ch1(0..N-1), ...] with
// `channels` channels and `samples` frames each. Mutates `entry.ir`.
const extractReflectionIr = (source, entry, transfers) => {
  const { irMaxFloats, irPointer, module } = runtime

  const size = module._sa_source_get_reflection_ir_size(source)
  if (!size)
    return // no IR available yet; leave entry.ir undefined
  const channels = size >>> 16
  const samples = size & 0xFFFF
  const total = channels * samples
  if (total <= 0 || total > irMaxFloats)
    return

  const written = module._sa_source_get_reflection_ir(source, irPointer, irMaxFloats)
  if (written !== total)
    return

  const base = irPointer >>> 2
  const data = new Float32Array(total)
  data.set(module.HEAPF32.subarray(base, base + total))

  let nonSilent = false
  for (let i = 0; i < total; i++) {
    if (data[i] !== 0) {
      nonSilent = true
      break
    }
  }
  if (!nonSilent)
    return

  entry.ir = { channels, data, samples }
  transfers.push(data.buffer)
}

const setSource = (source, input) => {
  const { module } = runtime
  withArray(module, module.HEAPF32, input.reverbScale, reverbScale =>
    module._sa_source_set_reflection_inputs(
      source,
      ...input.position,
      ...input.ahead,
      ...input.up,
      input.enabled ? 1 : 0,
      reverbScale,
    ))
}

const handlers = {
  'add-dynamic-mesh': (message) => {
    const { module, scene } = runtime
    const subScene = createHandle(module, out => module._sa_scene_create(runtime.context, out))
    const staticMesh = createStaticMesh(subScene, message.geometry, message.materialCount)
    module._sa_static_mesh_add(staticMesh, subScene)
    module._sa_scene_commit(subScene)
    const instance = createHandle(module, out =>
      withArray(module, module.HEAPF32, message.transform, transform =>
        module._sa_instanced_mesh_create(scene, subScene, transform, out)))
    meshes.set(message.id, { instance, staticMesh, subScene, type: 'dynamic' })
  },
  'add-source': (message) => {
    const { module, simulator } = runtime
    const source = createHandle(module, out =>
      module._sa_source_create(simulator, 2, out))
    sources.set(message.input.id, source)
    setSource(source, message.input)
  },
  'add-static-mesh': (message) => {
    const { module, scene } = runtime
    const mesh = createStaticMesh(scene, message.geometry, message.materialCount)
    module._sa_static_mesh_add(mesh, scene)
    meshes.set(message.id, { mesh, type: 'static' })
  },
  'commit-scene': () => {
    runtime.module._sa_scene_commit(runtime.scene)
    runtime.module._sa_simulator_commit(runtime.simulator)
    for (const release of pendingMeshReleases.splice(0))
      release()
  },
  'remove-mesh': (message) => {
    const entry = meshes.get(message.id)
    if (!entry)
      return
    const { module, scene } = runtime
    if (entry.type === 'static') {
      module._sa_static_mesh_remove(entry.mesh, scene)
      pendingMeshReleases.push(() => module._sa_static_mesh_release(entry.mesh))
    }
    else {
      module._sa_instanced_mesh_remove(entry.instance, scene)
      pendingMeshReleases.push(() => {
        module._sa_instanced_mesh_release(entry.instance)
        module._sa_static_mesh_release(entry.staticMesh)
        module._sa_scene_release(entry.subScene)
      })
    }
    meshes.delete(message.id)
  },
  'remove-source': (message) => {
    const source = sources.get(message.id)
    if (!source)
      return
    runtime.module._sa_source_release(source, runtime.simulator)
    sources.delete(message.id)
  },
  'run': () => {
    const { module, simulator } = runtime
    module._sa_simulator_run_reflections(simulator)
    const pointer = allocate(module, 3 * 4)
    const outputs = []
    const transfers = []
    for (const [id, source] of sources) {
      module._sa_source_get_reflection_outputs(source, pointer)
      const offset = pointer >>> 2
      const entry = {
        id,
        reverbTimes: [
          module.HEAPF32[offset],
          module.HEAPF32[offset + 1],
          module.HEAPF32[offset + 2],
        ],
      }
      // Head-tracked path: bake the per-pose binaural STEREO reflection IR
      // (impulse -> Ambisonic -> orientation decode) and transfer it (zero-copy)
      // to the main thread, which convolves the dry beacon through it. Throttled
      // to the sim update rate by virtue of running here, not at audio rate.
      if (runtime.headTracked)
        extractReflectionIr(source, entry, transfers)
      outputs.push(entry)
    }
    module._free(pointer)
    postMessage({ outputs, type: 'result' }, transfers)
  },
  'set-listener': (message) => {
    const { module, simulator } = runtime
    module._sa_simulator_set_listener(
      simulator,
      ...message.position,
      ...message.ahead,
      ...message.up,
      message.settings.rays,
      message.settings.bounces,
      message.settings.duration,
      message.settings.order,
      message.settings.irradianceMinDistance,
      0, // pathing_enabled: this worker's simulator is reflection-only
    )
    // Store the live head orientation for the binaural decode (head tracking
    // happens at decode time, not by re-simulating). Same ahead/up convention
    // the simulator gets.
    runtime.listenerAhead = message.ahead
    runtime.listenerUp = message.up
  },
  'update-dynamic-mesh': (message) => {
    const entry = meshes.get(message.id)
    if (!entry || entry.type !== 'dynamic')
      return
    const { module, scene } = runtime
    withArray(module, module.HEAPF32, message.transform, transform =>
      module._sa_instanced_mesh_update_transform(entry.instance, scene, transform))
  },
  'update-source': (message) => {
    const source = sources.get(message.input.id)
    if (source)
      setSource(source, message.input)
  },
}

const initialize = async (message) => {
  const module = await createSteamAudioModule({ wasmBinary: message.wasmBinary })
  const context = createHandle(module, out => module._sa_context_create(out))
  const scene = createHandle(module, out => module._sa_scene_create(context, out))
  const settings = message.settings
  const sampleRate = message.sampleRate
  const frameSize = message.frameSize
  const headTracked = Boolean(settings.headTracked)
  const order = settings.maxOrder ?? 1
  const simulator = createHandle(module, out => module._sa_simulator_create(
    context,
    scene,
    sampleRate,
    frameSize,
    message.maxSources,
    1,
    1,
    settings.maxRays,
    settings.diffuseSamples,
    settings.maxDuration,
    settings.maxOrder,
    1,
    headTracked ? 1 : 0,
    out,
  ))

  runtime = {
    context,
    frameSize,
    headTracked,
    // Listener orientation for the binaural decode; canonical until the first
    // set-listener arrives (ahead -Z, up +Y — Steam's default head frame).
    listenerAhead: [0, 0, -1],
    listenerUp: [0, 1, 0],
    module,
    order,
    sampleRate,
    scene,
    simulator,
  }

  if (!headTracked)
    return

  // Head-tracked reflection rendering: ship the source's raw Ambisonic IR taps.
  // The convolution + head-tracked decode run in the AudioWorklet (Steam's own
  // overlap-save convolver), so this worker only needs a scratch buffer big
  // enough to copy the taps out of the internal ImpulseResponse. Size it for the
  // configured Ambisonic order and a generous max IR duration; the actual copy
  // is bounded by the real IR size reported by sa_source_get_reflection_ir_size.
  const channels = (order + 1) * (order + 1)
  const maxIrDuration = settings.maxDuration ?? 1
  const irMaxFloats = channels * Math.ceil(maxIrDuration * sampleRate)

  Object.assign(runtime, {
    irMaxFloats,
    irPointer: allocate(module, irMaxFloats * 4),
  })
}

const dispose = () => {
  if (!runtime)
    return
  for (const id of [...sources.keys()])
    handlers['remove-source']({ id })
  for (const id of [...meshes.keys()])
    handlers['remove-mesh']({ id })
  handlers['commit-scene']()
  const { module } = runtime
  if (runtime.headTracked && runtime.irPointer)
    module._free(runtime.irPointer)
  module._sa_simulator_release(runtime.simulator)
  module._sa_scene_release(runtime.scene)
  module._sa_context_release(runtime.context)
  postMessage({ type: 'disposed' })
  close()
}

let ready

onmessage = async ({ data }) => {
  try {
    if (data?.type === 'init') {
      ready = initialize(data)
      await ready
      return
    }
    await ready
    if (data?.type === 'dispose') {
      dispose()
      return
    }
    handlers[data?.type]?.(data)
  }
  catch (error) {
    postMessage({
      message: error instanceof Error ? error.message : String(error),
      type: 'error',
    })
  }
}
