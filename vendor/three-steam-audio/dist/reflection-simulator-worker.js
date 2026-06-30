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

// Bake the per-pose BINAURAL STEREO reflection impulse response for one source.
//
// Reflections are a linear filter, so rather than streaming audio we render the
// source's reflection effect's response to a UNIT IMPULSE and decode it to
// stereo for the CURRENT listener orientation. The worklet/main thread then just
// convolves the dry beacon with this stereo IR (a Web Audio ConvolverNode).
//
// Pipeline (all in this WASM instance), per de-risk findings:
//   1. The caller must have run sa_simulator_run_reflections immediately before
//      this (a stale IR handle yields silence) — see the `run` handler.
//   2. Feed a unit impulse (block 0) + zero-blocks to flush the partitioned-FFT
//      tail through sa_source_apply_convolution_reflection -> world-frame
//      Ambisonic field.
//   3. Decode each block to STEREO with sa_ambisonics_decode_effect_apply using
//      the LIVE listener ahead/up (rotation happens at decode, NOT by
//      re-simulating).
// Output: channel-major Float32Array [L(0..N-1), R(0..N-1)] of `irSamples`
// frames. Mutates `entry.ir` and pushes the backing buffer onto `transfers`.
const bakeStereoIr = (source, entry, transfers) => {
  const {
    ambiPointer,
    captureBlocks,
    channels,
    decodeEffect,
    frameSize,
    hrtf,
    irDuration,
    irSamples,
    listenerAhead,
    listenerUp,
    module,
    monoPointer,
    order,
    reflectionEffect,
    sampleRate,
    stereoPointer,
  } = runtime

  // Fresh convolution + decode state for this bake.
  module._sa_reflection_effect_reset(reflectionEffect)
  module._sa_ambisonics_decode_effect_reset(decodeEffect)

  const out = new Float32Array(2 * irSamples)
  const monoBase = monoPointer >>> 2
  const ambiFloats = channels * frameSize
  const stereoBase = stereoPointer >>> 2
  let wrote = 0
  let nonSilent = false

  for (let block = 0; block < captureBlocks && wrote < irSamples; block++) {
    // Unit impulse in block 0, silence afterwards.
    module.HEAPF32.fill(0, monoBase, monoBase + frameSize)
    if (block === 0)
      module.HEAPF32[monoBase] = 1

    module.HEAPF32.fill(0, ambiPointer >>> 2, (ambiPointer >>> 2) + ambiFloats)
    const applyStatus = module._sa_source_apply_convolution_reflection(
      reflectionEffect,
      source,
      order,
      sampleRate,
      irDuration,
      monoPointer,
      ambiPointer,
      frameSize,
    )
    if (applyStatus !== 0)
      return // no IR available yet; leave entry.ir undefined

    module.HEAPF32.fill(0, stereoBase, stereoBase + 2 * frameSize)
    const decodeStatus = module._sa_ambisonics_decode_effect_apply(
      decodeEffect,
      hrtf,
      order,
      listenerAhead[0],
      listenerAhead[1],
      listenerAhead[2],
      listenerUp[0],
      listenerUp[1],
      listenerUp[2],
      1, // binaural
      ambiPointer,
      stereoPointer,
      frameSize,
    )
    if (decodeStatus !== 0)
      return

    const take = Math.min(frameSize, irSamples - wrote)
    for (let i = 0; i < take; i++) {
      const l = module.HEAPF32[stereoBase + i]
      const r = module.HEAPF32[stereoBase + frameSize + i]
      out[wrote + i] = l
      out[irSamples + wrote + i] = r
      if (l !== 0 || r !== 0)
        nonSilent = true
    }
    wrote += take
  }

  if (!nonSilent)
    return
  entry.ir = { data: out, samples: irSamples }
  transfers.push(out.buffer)
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
        bakeStereoIr(source, entry, transfers)
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

const createSofaHrtf = (module, context, sampleRate, frameSize, sofaData) => {
  const bytes = new Uint8Array(sofaData)
  const pointer = allocate(module, bytes.byteLength)
  try {
    module.HEAPU8.set(bytes, pointer)
    return createHandle(module, out =>
      module._sa_hrtf_create_sofa(
        context,
        sampleRate,
        frameSize,
        pointer,
        bytes.byteLength,
        out,
      ))
  }
  finally {
    module._free(pointer)
  }
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

  // Head-tracked reflection rendering: bake a per-pose binaural STEREO IR.
  const channels = (order + 1) * (order + 1)
  // Baked binaural IR length. Short by design (directional cue is in the early
  // reflections); bounds bake + convolution cost. captureBlocks covers the
  // duration plus a few blocks of partitioned-FFT latency to flush the tail.
  const irDuration = settings.irDuration ?? 0.2
  const irSamples = Math.round(irDuration * sampleRate)
  const captureBlocks = Math.ceil(irSamples / frameSize) + 4

  const hrtf = message.sofaData
    ? createSofaHrtf(module, context, sampleRate, frameSize, message.sofaData)
    : createHandle(module, out =>
        module._sa_hrtf_create(context, sampleRate, frameSize, out))
  const reflectionEffect = createHandle(module, out =>
    module._sa_convolution_reflection_effect_create(
      context,
      sampleRate,
      frameSize,
      order,
      irDuration,
      out,
    ))
  const decodeEffect = createHandle(module, out =>
    module._sa_ambisonics_decode_effect_create(
      context,
      sampleRate,
      frameSize,
      hrtf,
      order,
      out,
    ))

  Object.assign(runtime, {
    ambiPointer: allocate(module, channels * frameSize * 4),
    captureBlocks,
    channels,
    decodeEffect,
    hrtf,
    irDuration,
    irSamples,
    monoPointer: allocate(module, frameSize * 4),
    reflectionEffect,
    stereoPointer: allocate(module, 2 * frameSize * 4),
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
  if (runtime.headTracked) {
    if (runtime.decodeEffect)
      module._sa_ambisonics_decode_effect_release(runtime.decodeEffect)
    if (runtime.reflectionEffect)
      module._sa_reflection_effect_release(runtime.reflectionEffect)
    if (runtime.hrtf)
      module._sa_hrtf_release(runtime.hrtf)
    if (runtime.monoPointer)
      module._free(runtime.monoPointer)
    if (runtime.ambiPointer)
      module._free(runtime.ambiPointer)
    if (runtime.stereoPointer)
      module._free(runtime.stereoPointer)
  }
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
