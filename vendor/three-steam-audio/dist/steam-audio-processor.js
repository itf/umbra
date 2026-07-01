/* global AudioWorkletProcessor, registerProcessor, sampleRate */
import createSteamAudioModule from './bindings/phonon_bindings.js'

const CONTROL_VALUE_COUNT = 23
const runtimePromises = new Map()

const allocate = (module, byteLength) => {
  const pointer = module._malloc(byteLength)
  if (!pointer)
    throw new Error(`Steam Audio worklet could not allocate ${byteLength} bytes`)
  return pointer
}

const createHandle = (module, create) => {
  const out = allocate(module, 4)
  try {
    module.HEAPU32[out >>> 2] = 0
    const status = create(out)
    if (status !== 0)
      throw new Error(`Steam Audio worklet initialization failed with status ${status}`)
    const handle = module.HEAPU32[out >>> 2]
    if (!handle)
      throw new Error('Steam Audio worklet initialization returned a null handle')
    return handle
  }
  finally {
    module._free(out)
  }
}

// Build an HRTF from in-memory SOFA bytes: copy the buffer into the WASM heap,
// call the SOFA-aware export, then free the temporary heap allocation.
const createSofaHrtf = (module, context, frameSize, sofaData) => {
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

const getRuntime = (wasmBinary, frameSize, sofaData) => {
  // SOFA HRTFs cannot share the default runtime cache: key by frame size plus
  // the SOFA buffer identity so each distinct HRTF gets its own module/hrtf.
  const cacheKey = sofaData
    ? `${frameSize}:sofa:${runtimeKeyFor(sofaData)}`
    : `${frameSize}`
  let promise = runtimePromises.get(cacheKey)
  if (!promise) {
    promise = createSteamAudioModule({
      locateFile: path => path,
      wasmBinary,
    }).then((module) => {
      const context = createHandle(module, out => module._sa_context_create(out))
      const hrtf = sofaData
        ? createSofaHrtf(module, context, frameSize, sofaData)
        : createHandle(module, out =>
            module._sa_hrtf_create(context, sampleRate, frameSize, out))
      return { context, hrtf, module }
    })
    runtimePromises.set(cacheKey, promise)
  }
  return promise
}

const runtimeKeys = new WeakMap()
let nextRuntimeKey = 0
const runtimeKeyFor = (buffer) => {
  let key = runtimeKeys.get(buffer)
  if (key === undefined) {
    key = nextRuntimeKey++
    runtimeKeys.set(buffer, key)
  }
  return key
}

class SteamAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const processorOptions = options.processorOptions ?? {}
    this.frameSize = processorOptions.frameSize
    // Head-tracked reflections (opt-in). When set, output[1] carries the fully
    // rendered, directional reflected field produced INSIDE this worklet: the
    // reflection worker ships RAW Ambisonic IR taps (reflection-simulator-worker.js),
    // and per block we run Steam's own overlap-save convolver against them, then
    // decode Ambisonics->binaural with the LIVE head orientation (see
    // applyReflections). When headTracked is off, output[1] carries the legacy
    // mono-duplicated parametric reflected field.
    this.headTracked = processorOptions.headTracked === true
    // Head-tracked reflections: the worklet runs Steam's OWN partitioned-FFT
    // overlap-save convolver against the raw Ambisonic IR taps shipped from the
    // reflection worker, then decodes to binaural with the LIVE head orientation
    // every block. The convolver keeps its state across sim updates (a new IR is
    // partitioned and adopted seamlessly — no ConvolverNode swap, no ~10Hz beat).
    this.reflectionOrder = Math.max(0, Math.min(3, processorOptions.reflectionOrder ?? 1))
    this.reflectionChannels = (this.reflectionOrder + 1) * (this.reflectionOrder + 1)
    // Live listener orientation for the reflection decode, pushed at sim rate.
    // [ahead(3), up(3)], canonical head frame until the first update.
    this.reflectionListener = new Float32Array([0, 0, -1, 0, 1, 0])
    this.reflectionConvolver = 0 // created lazily on the first IR (needs its size)
    this.reflectionIrSamples = 0
    this.reflectionPartitionPending = false // an IR was staged; partition it next block
    // Pathing / diffraction (opt-in). When enabled this worklet renders a
    // directional Ambisonic pathing field on output[3]: per block it applies the
    // baked path effect (eq3 + SH coefficients pushed from the main thread at sim
    // rate) to the dry mono input, then decodes the resulting Ambisonics to
    // binaural with the LIVE listener orientation using the same
    // sa_ambisonics_decode_effect the head-tracked reflection path uses. So the
    // diffracted sound arrives from the correct direction and rotates with the
    // head. When pathing is off, output[3] is silent and no pathing effects are
    // created (existing behavior is unchanged).
    this.pathingEnabled = processorOptions.pathing === true
    this.pathingOrder = Math.max(0, Math.min(3, processorOptions.pathingOrder ?? 1))
    this.pathingChannels = (this.pathingOrder + 1) * (this.pathingOrder + 1)
    // eq3(3) + SH((order+1)^2) + ahead(3) + up(3) + normalizeEq(1) + wet(1).
    this.pathControl = new Float32Array(3 + this.pathingChannels + 3 + 3 + 1 + 1)
    // Sensible defaults: unit eq, W-only SH, canonical orientation, wet 1.
    this.pathControl[0] = 1
    this.pathControl[1] = 1
    this.pathControl[2] = 1
    // ahead = (0,0,-1), up = (0,1,0).
    this.pathControl[3 + this.pathingChannels + 2] = -1
    this.pathControl[3 + this.pathingChannels + 4] = 1
    this.pathControl[this.pathControl.length - 1] = 1
    this.controlBuffer = processorOptions.controlBuffer
    this.controlSequence = this.controlBuffer
      ? new Int32Array(this.controlBuffer, 0, 1)
      : undefined
    this.sharedControl = this.controlBuffer
      ? new Float32Array(this.controlBuffer, 4, CONTROL_VALUE_COUNT)
      : undefined
    this.control = new Float32Array(CONTROL_VALUE_COUNT)
    this.control[0] = 1
    this.control[1] = 1
    this.control[2] = 1
    this.control[3] = 1
    this.control[4] = 1
    this.control[5] = 1
    this.control[6] = 1
    this.control[7] = 1
    this.control[8] = 1
    this.control[11] = -1
    this.control[12] = 1
    this.control[14] = 1
    this.hrtfMix = 1

    const ringSize = this.frameSize * 2
    this.inputLeft = new Float32Array(ringSize)
    this.inputRight = new Float32Array(ringSize)
    this.inputActive = new Uint8Array(ringSize)
    this.outputLeft = new Float32Array(ringSize)
    this.outputRight = new Float32Array(ringSize)
    this.reflectionLeft = new Float32Array(ringSize)
    this.reflectionRight = new Float32Array(ringSize)
    this.reverbLeft = new Float32Array(ringSize)
    this.reverbRight = new Float32Array(ringSize)
    this.pathingLeftRing = new Float32Array(ringSize)
    this.pathingRightRing = new Float32Array(ringSize)
    this.inputRead = 0
    this.inputWrite = 0
    this.inputCount = 0
    this.outputRead = 0
    this.outputWrite = 0
    this.outputCount = 0
    this.disposed = false
    this.failed = false
    this.ready = false

    this.port.onmessage = ({ data }) => {
      if (data?.type === 'control' && data.values)
        this.control.set(data.values)
      else if (data?.type === 'pathing' && data.values)
        this.pathControl.set(data.values)
      else if (data?.type === 'reflectionListener' && data.values)
        this.reflectionListener.set(data.values)
      else if (data?.type === 'reflectionIr' && data.data)
        this.stageReflectionIr(data.data, data.channels, data.samples)
      else if (data?.type === 'dispose')
        this.dispose()
    }

    getRuntime(processorOptions.wasmBinary, this.frameSize, processorOptions.sofaData)
      .then(runtime => this.initialize(runtime))
      .catch((error) => {
        this.failed = true
        this.port.postMessage({
          message: error instanceof Error ? error.message : String(error),
          type: 'error',
        })
      })
  }

  // Run the parametric reflection (output[1]) and reverb (output[2]) effects for
  // this block. The reflection effect is only needed for the legacy
  // mono-duplicated reflected field; in headTracked mode the reflection send is
  // the dry mono signal (the main-thread ConvolverNode does the filtering), so
  // skip it. The reverb effect always runs. `inputActive` selects apply vs tail.
  applyParametricBuses(module, inputActive) {
    if (!this.headTracked) {
      if (inputActive) {
        module._sa_reflection_effect_apply(
          this.reflectionEffect,
          this.reflectionTimesPointer,
          this.monoPointer,
          this.reflectionPointer,
          this.frameSize,
        )
      }
      else {
        module._sa_reflection_effect_get_tail(
          this.reflectionEffect,
          this.reflectionPointer,
          this.frameSize,
        )
      }
    }
    if (inputActive) {
      module._sa_reflection_effect_apply(
        this.reverbEffect,
        this.reverbTimesPointer,
        this.monoPointer,
        this.reverbPointer,
        this.frameSize,
      )
    }
    else {
      module._sa_reflection_effect_get_tail(
        this.reverbEffect,
        this.reverbPointer,
        this.frameSize,
      )
    }
  }

  // Render the diffracted (pathing) field for one block. inMonoPointer is the
  // dry mono input. The path effect turns eq3 + SH into an Ambisonic field; the
  // ambisonics decode effect turns that into binaural using the live listener
  // ahead/up (head-tracked), so the diffracted arrival direction is preserved.
  applyPathing(module, inMonoPointer) {
    const heap = module.HEAPF32
    const eqOffset = this.pathEq3Pointer >>> 2
    const shOffset = this.pathShPointer >>> 2
    const listenerOffset = this.pathListenerPointer >>> 2
    // pathControl layout: [eq3(3), SH(channels), ahead(3), up(3), normalizeEq, wet]
    const aheadBase = 3 + this.pathingChannels
    for (let i = 0; i < 3; i++)
      heap[eqOffset + i] = this.pathControl[i]
    for (let i = 0; i < this.pathingChannels; i++)
      heap[shOffset + i] = this.pathControl[3 + i]
    // Listener transform for the decode: position is irrelevant for the SH
    // rotation, ahead/up carry the head orientation. Feed [pos(3), ahead(3), up(3)].
    heap[listenerOffset + 0] = 0
    heap[listenerOffset + 1] = 0
    heap[listenerOffset + 2] = 0
    for (let i = 0; i < 6; i++)
      heap[listenerOffset + 3 + i] = this.pathControl[aheadBase + i]
    const normalizeEq = this.pathControl[aheadBase + 6]

    module._sa_path_effect_apply(
      this.pathEffect,
      this.pathEq3Pointer,
      this.pathShPointer,
      this.pathingOrder,
      0, // binaural=0: emit Ambisonics, we decode below
      0, // hrtf (unused when binaural=0)
      heap[listenerOffset + 0],
      heap[listenerOffset + 1],
      heap[listenerOffset + 2],
      heap[listenerOffset + 3],
      heap[listenerOffset + 4],
      heap[listenerOffset + 5],
      heap[listenerOffset + 6],
      heap[listenerOffset + 7],
      heap[listenerOffset + 8],
      normalizeEq > 0 ? 1 : 0,
      inMonoPointer,
      this.pathAmbisonicPointer,
      this.frameSize,
    )
    module._sa_ambisonics_decode_effect_apply(
      this.pathDecodeEffect,
      this.runtime.hrtf,
      this.pathingOrder,
      heap[listenerOffset + 3],
      heap[listenerOffset + 4],
      heap[listenerOffset + 5],
      heap[listenerOffset + 6],
      heap[listenerOffset + 7],
      heap[listenerOffset + 8],
      1, // binaural
      this.pathAmbisonicPointer,
      this.pathBinauralPointer,
      this.frameSize,
    )
  }

  // Render the head-tracked reflected field for one block. dryMonoPointer holds
  // the dry input downmix; it is scaled by the reflection wet into the send
  // scratch. Partition any staged IR (once), convolve to an Ambisonic field with
  // Steam's overlap-save convolver, then decode to binaural with the LIVE head
  // orientation. Writes [L block, R block] into reflectionBinauralPointer.
  //
  // LEVEL NOTE: the reflection send is fed the RAW dry signal (only the wet mix
  // gain applied), exactly as stock Steam Audio does — Steam's own spatializer
  // feeds reflections a raw, NON-distance-attenuated send and relies on the
  // reflection IR (ray-traced path lengths + per-bounce absorption) to carry the
  // correct absolute level. We deliberately do NOT scale the send by the source's
  // 1/r distance attenuation: that would be physically WRONG. Real reflections do
  // not fall off with the source->listener straight-line distance; each reflection
  // follows its own source->wall->listener path and falls off with THAT path
  // length, which Steam's IR already encodes. Imposing the direct path's 1/r on
  // reflections would make a beacon's reflections incorrectly shrink just because
  // it is far away in the same room, corrupting the spatial cue. If reflections
  // are too loud relative to direct, the correct, physics-honest levers are:
  //   (1) the reflectionWet mix gain here (Steam's own reflectionsMixLevel
  //       equivalent — a sanctioned mix decision, not a physics claim), and
  //   (2) content: materials with real low-band absorption / a beacon frequency
  //       inside the material's absorptive band (Steam's coarse 3-band material
  //       model reflects sub-~400Hz strongly even off "foam").
  applyReflections(module, dryMonoPointer, reflectionWet) {
    const heap = module.HEAPF32
    if (!this.reflectionConvolver) {
      heap.fill(0, this.reflectionBinauralPointer >>> 2, (this.reflectionBinauralPointer >>> 2) + 2 * this.frameSize)
      return
    }
    // Scale the dry send by the wet mix gain into the convolver input scratch.
    const dryOffset = dryMonoPointer >>> 2
    const sendOffset = this.reflectionSendPointer >>> 2
    for (let index = 0; index < this.frameSize; index++)
      heap[sendOffset + index] = heap[dryOffset + index] * reflectionWet
    if (this.reflectionPartitionPending) {
      module._sa_reflection_convolver_partition(
        this.reflectionConvolver,
        this.reflectionIrPointer,
        this.reflectionStagedChannels,
        this.reflectionStagedSamples,
      )
      this.reflectionPartitionPending = false
    }
    module._sa_reflection_convolver_apply(
      this.reflectionConvolver,
      this.reflectionSendPointer,
      this.reflectionAmbisonicPointer,
      this.frameSize,
    )
    const l = this.reflectionListener
    module._sa_ambisonics_decode_effect_apply(
      this.reflectionDecodeEffect,
      this.runtime.hrtf,
      this.reflectionOrder,
      l[0],
      l[1],
      l[2],
      l[3],
      l[4],
      l[5],
      1, // binaural
      this.reflectionAmbisonicPointer,
      this.reflectionBinauralPointer,
      this.frameSize,
    )
  }

  dispose() {
    if (this.disposed)
      return
    this.disposed = true
    if (!this.ready)
      return
    const { module } = this.runtime
    module._sa_binaural_effect_release(this.binauralEffect)
    module._sa_direct_effect_release(this.directEffect)
    module._sa_reflection_effect_release(this.reflectionEffect)
    module._sa_reflection_effect_release(this.reverbEffect)
    module._free(this.inputPointer)
    module._free(this.directPointer)
    module._free(this.outputPointer)
    module._free(this.airPointer)
    module._free(this.transmissionPointer)
    module._free(this.monoPointer)
    module._free(this.reflectionPointer)
    module._free(this.reverbPointer)
    module._free(this.reflectionTimesPointer)
    module._free(this.reverbTimesPointer)
    if (this.headTracked) {
      if (this.reflectionConvolver)
        module._sa_reflection_convolver_release(this.reflectionConvolver)
      if (this.reflectionIrPointer)
        module._free(this.reflectionIrPointer)
      if (this.reflectionDecodeEffect)
        module._sa_ambisonics_decode_effect_release(this.reflectionDecodeEffect)
      module._free(this.reflectionAmbisonicPointer)
      module._free(this.reflectionBinauralPointer)
      module._free(this.reflectionSendPointer)
    }
    if (this.pathingEnabled && this.pathEffect) {
      module._sa_path_effect_release(this.pathEffect)
      module._sa_ambisonics_decode_effect_release(this.pathDecodeEffect)
      module._free(this.pathEq3Pointer)
      module._free(this.pathShPointer)
      module._free(this.pathListenerPointer)
      module._free(this.pathAmbisonicPointer)
      module._free(this.pathBinauralPointer)
    }
    this.ready = false
  }

  initialize(runtime) {
    if (this.disposed)
      return
    this.runtime = runtime
    const { context, hrtf, module } = runtime
    this.directEffect = createHandle(module, out =>
      module._sa_direct_effect_create(context, sampleRate, this.frameSize, 2, out))
    this.binauralEffect = createHandle(module, out =>
      module._sa_binaural_effect_create(context, sampleRate, this.frameSize, hrtf, out))
    this.reflectionEffect = createHandle(module, out =>
      module._sa_reflection_effect_create(context, sampleRate, this.frameSize, 1, out))
    this.reverbEffect = createHandle(module, out =>
      module._sa_reflection_effect_create(context, sampleRate, this.frameSize, 1, out))
    this.inputPointer = allocate(module, this.frameSize * 2 * 4)
    this.directPointer = allocate(module, this.frameSize * 2 * 4)
    this.outputPointer = allocate(module, this.frameSize * 2 * 4)
    this.airPointer = allocate(module, 3 * 4)
    this.transmissionPointer = allocate(module, 3 * 4)
    this.monoPointer = allocate(module, this.frameSize * 4)
    this.reflectionPointer = allocate(module, this.frameSize * 4)
    this.reverbPointer = allocate(module, this.frameSize * 4)
    this.reflectionTimesPointer = allocate(module, 3 * 4)
    this.reverbTimesPointer = allocate(module, 3 * 4)
    if (this.headTracked) {
      // Ambisonics->binaural decode for the head-tracked reflected field, driven
      // by the LIVE listener orientation each block (same effect the pathing path
      // uses). The convolver itself is created lazily on the first IR message
      // (stageReflectionIr) since it needs the IR length.
      this.reflectionDecodeEffect = createHandle(module, out =>
        module._sa_ambisonics_decode_effect_create(
          context,
          sampleRate,
          this.frameSize,
          hrtf,
          this.reflectionOrder,
          out,
        ))
      // Ambisonic intermediate ((order+1)^2 channels, channel-major) + binaural.
      this.reflectionAmbisonicPointer = allocate(module, this.reflectionChannels * this.frameSize * 4)
      this.reflectionBinauralPointer = allocate(module, 2 * this.frameSize * 4)
      // Scratch for the dry mono reflection send fed to the convolver.
      this.reflectionSendPointer = allocate(module, this.frameSize * 4)
    }
    if (this.pathingEnabled) {
      // Path effect: Ambisonic output (spatialize=0, hrtf=NULL) — we decode to
      // binaural separately with the live listener orientation.
      this.pathEffect = createHandle(module, out =>
        module._sa_path_effect_create(
          context,
          sampleRate,
          this.frameSize,
          this.pathingOrder,
          0,
          0,
          out,
        ))
      // Same Ambisonic->binaural decode effect used by the head-tracked
      // reflection path (reflection-simulator-worker.js), so diffraction is
      // directional.
      this.pathDecodeEffect = createHandle(module, out =>
        module._sa_ambisonics_decode_effect_create(
          context,
          sampleRate,
          this.frameSize,
          hrtf,
          this.pathingOrder,
          out,
        ))
      this.pathEq3Pointer = allocate(module, 3 * 4)
      this.pathShPointer = allocate(module, this.pathingChannels * 4)
      this.pathListenerPointer = allocate(module, 9 * 4)
      // Ambisonic intermediate ((order+1)^2 channels, channel-major).
      this.pathAmbisonicPointer = allocate(module, this.pathingChannels * this.frameSize * 4)
      this.pathBinauralPointer = allocate(module, 2 * this.frameSize * 4)
    }
    this.ready = true
    this.port.postMessage({ type: 'ready' })
  }

  process(inputs, outputs) {
    const output = outputs[0]
    const reflectionOutput = outputs[1]
    const reverbOutput = outputs[2]
    // output[3] (pathing) only exists when the node was created with pathing.
    const pathingOutput = outputs[3]
    if (!output?.[0] || !output?.[1]
      || !reflectionOutput?.[0] || !reflectionOutput?.[1]
      || !reverbOutput?.[0] || !reverbOutput?.[1]) {
      return !this.disposed
    }
    const quantumSize = output[0].length
    if (!this.ready) {
      for (const target of [output, reflectionOutput, reverbOutput, pathingOutput]) {
        if (!target)
          continue
        for (const channel of target)
          channel.fill(0)
      }
      return !this.disposed
    }

    this.readSharedControl()
    this.pushInput(inputs[0], quantumSize)
    while (this.inputCount >= this.frameSize)
      this.processBlock()
    this.pullOutput(output, reflectionOutput, reverbOutput, pathingOutput, quantumSize)
    return !this.disposed
  }

  processBlock() {
    const { module } = this.runtime
    const heap = module.HEAPF32
    const inputOffset = this.inputPointer >>> 2
    let inputActive = false
    for (let index = 0; index < this.frameSize; index++) {
      heap[inputOffset + index] = this.inputLeft[this.inputRead]
      heap[inputOffset + this.frameSize + index] = this.inputRight[this.inputRead]
      inputActive ||= this.inputActive[this.inputRead] !== 0
      this.inputRead = (this.inputRead + 1) % this.inputLeft.length
    }
    this.inputCount -= this.frameSize

    const airOffset = this.airPointer >>> 2
    const transmissionOffset = this.transmissionPointer >>> 2
    for (let band = 0; band < 3; band++) {
      heap[airOffset + band] = this.control[1 + band]
      heap[transmissionOffset + band] = this.control[6 + band]
    }
    const hrtf = this.control[14] > 0
    const transmissionType = Math.abs(this.control[14]) - 1
    module._sa_direct_effect_apply(
      this.directEffect,
      this.control[13],
      transmissionType,
      this.control[0],
      this.airPointer,
      this.control[4],
      this.control[5],
      this.transmissionPointer,
      this.inputPointer,
      this.directPointer,
      2,
      this.frameSize,
    )
    const directOffset = this.directPointer >>> 2
    const monoOffset = this.monoPointer >>> 2
    for (let index = 0; index < this.frameSize; index++) {
      heap[monoOffset + index] = 0.5 * (
        heap[directOffset + index]
        + heap[directOffset + this.frameSize + index]
      )
    }
    module._sa_binaural_effect_apply(
      this.binauralEffect,
      this.runtime.hrtf,
      this.control[9],
      this.control[10],
      this.control[11],
      this.control[12],
      this.monoPointer,
      this.outputPointer,
      1,
      this.frameSize,
    )

    const reflectionTimesOffset = this.reflectionTimesPointer >>> 2
    const reverbTimesOffset = this.reverbTimesPointer >>> 2
    for (let index = 0; index < this.frameSize; index++) {
      heap[monoOffset + index] = 0.5 * (
        heap[inputOffset + index]
        + heap[inputOffset + this.frameSize + index]
      )
    }
    for (let band = 0; band < 3; band++) {
      heap[reflectionTimesOffset + band] = this.control[15 + band]
      heap[reverbTimesOffset + band] = this.control[19 + band]
    }
    this.applyParametricBuses(module, inputActive)

    // Head-tracked reflection render. monoPointer holds the dry input downmix;
    // applyReflections scales it by the reflection wet (control[18]), runs Steam's
    // overlap-save convolver against the raw Ambisonic IR taps, and decodes to
    // binaural with the LIVE head orientation into reflectionBinauralPointer.
    if (this.headTracked)
      this.applyReflections(module, this.monoPointer, this.control[18])

    // Pathing / diffraction render. monoPointer currently holds the dry input
    // downmix. Apply the baked path effect (eq3 + SH from the main thread) to
    // produce an Ambisonic field, then decode it to binaural with the LIVE
    // listener orientation so the diffracted sound is directional. Writes into
    // pathBinauralPointer as [L block, R block] (channel-major stereo, matching
    // the ambisonics decode effect's output layout).
    if (this.pathingEnabled)
      this.applyPathing(module, this.monoPointer)

    const targetMix = hrtf ? 1 : 0
    const mixStep = 1 / (sampleRate * 0.02)
    const outputOffset = this.outputPointer >>> 2
    const reflectionOffset = this.reflectionPointer >>> 2
    const reverbOffset = this.reverbPointer >>> 2
    for (let index = 0; index < this.frameSize; index++) {
      if (this.hrtfMix < targetMix)
        this.hrtfMix = Math.min(targetMix, this.hrtfMix + mixStep)
      else if (this.hrtfMix > targetMix)
        this.hrtfMix = Math.max(targetMix, this.hrtfMix - mixStep)
      const dryMix = 1 - this.hrtfMix
      heap[outputOffset + index] = heap[outputOffset + index] * this.hrtfMix
        + heap[directOffset + index] * dryMix
      heap[outputOffset + this.frameSize + index]
        = heap[outputOffset + this.frameSize + index] * this.hrtfMix
          + heap[directOffset + this.frameSize + index] * dryMix
    }

    this.writeOutputBlock(heap, outputOffset, reflectionOffset, reverbOffset)
  }

  pullOutput(output, reflectionOutput, reverbOutput, pathingOutput, quantumSize) {
    const left = output[0]
    const right = output[1]
    for (let index = 0; index < quantumSize; index++) {
      if (this.outputCount > 0) {
        left[index] = this.outputLeft[this.outputRead]
        right[index] = this.outputRight[this.outputRead]
        reflectionOutput[0][index] = this.reflectionLeft[this.outputRead]
        reflectionOutput[1][index] = this.reflectionRight[this.outputRead]
        reverbOutput[0][index] = this.reverbLeft[this.outputRead]
        reverbOutput[1][index] = this.reverbRight[this.outputRead]
        if (pathingOutput?.[0] && pathingOutput?.[1]) {
          pathingOutput[0][index] = this.pathingLeftRing[this.outputRead]
          pathingOutput[1][index] = this.pathingRightRing[this.outputRead]
        }
        this.outputRead = (this.outputRead + 1) % this.outputLeft.length
        this.outputCount--
      }
      else {
        left[index] = 0
        right[index] = 0
        reflectionOutput[0][index] = 0
        reflectionOutput[1][index] = 0
        reverbOutput[0][index] = 0
        reverbOutput[1][index] = 0
        if (pathingOutput?.[0] && pathingOutput?.[1]) {
          pathingOutput[0][index] = 0
          pathingOutput[1][index] = 0
        }
      }
    }
  }

  pushInput(input, quantumSize) {
    const left = input?.[0]
    const right = input?.[1] ?? left
    const active = left !== undefined
    for (let index = 0; index < quantumSize; index++) {
      this.inputLeft[this.inputWrite] = left?.[index] ?? 0
      this.inputRight[this.inputWrite] = right?.[index] ?? 0
      this.inputActive[this.inputWrite] = active ? 1 : 0
      this.inputWrite = (this.inputWrite + 1) % this.inputLeft.length
      this.inputCount++
    }
  }

  readSharedControl() {
    if (!this.controlSequence || !this.sharedControl)
      return
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = Atomics.load(this.controlSequence, 0)
      if (before & 1)
        continue
      this.control.set(this.sharedControl)
      const after = Atomics.load(this.controlSequence, 0)
      if (before === after)
        return
    }
  }

  // Stage a freshly-simulated raw Ambisonic reflection IR (channel-major taps).
  // Creates the overlap-save convolver on first use (sized to this IR), then
  // partitions the new taps into it. The actual partition happens on the audio
  // thread at the top of the next block (processBlock), so the convolver is only
  // touched from one thread. Sets fftIRUpdated-once semantics via the binding.
  stageReflectionIr(data, channels, samples) {
    if (this.disposed || !this.ready || !this.headTracked || samples <= 0)
      return
    const { module } = this.runtime
    // (Re)create the convolver if this is the first IR or the length grew.
    if (!this.reflectionConvolver || samples > this.reflectionIrSamples) {
      if (this.reflectionConvolver) {
        module._sa_reflection_convolver_release(this.reflectionConvolver)
        this.reflectionConvolver = 0
        module._free(this.reflectionIrPointer)
      }
      this.reflectionConvolver = createHandle(module, out =>
        module._sa_reflection_convolver_create(
          this.reflectionOrder,
          samples,
          this.frameSize,
          sampleRate,
          out,
        ))
      this.reflectionIrSamples = samples
      this.reflectionIrPointer = allocate(module, this.reflectionChannels * samples * 4)
    }
    // Copy the taps (clamped to the convolver's channels) into the heap scratch.
    const useChannels = Math.min(channels, this.reflectionChannels)
    const heap = module.HEAPF32
    const base = this.reflectionIrPointer >>> 2
    const view = new Float32Array(data)
    for (let ch = 0; ch < useChannels; ch++)
      heap.set(view.subarray(ch * samples, ch * samples + samples), base + ch * samples)
    this.reflectionStagedChannels = useChannels
    this.reflectionStagedSamples = samples
    this.reflectionPartitionPending = true
  }

  // Copy this block's rendered buses into the output ring buffers. Direct binaural
  // is in outputOffset; the reflection send (output[1]) is either the finished
  // head-tracked binaural field (reflectionBinauralPointer, L block + R block) or
  // the legacy mono parametric field (reflectionOffset, scaled by wet); reverb is
  // mono in reverbOffset. Source offsets/gains are resolved ONCE so the tight
  // per-sample loop stays branch-free.
  writeOutputBlock(heap, outputOffset, reflectionOffset, reverbOffset) {
    const reflectLeftOffset = this.headTracked
      ? this.reflectionBinauralPointer >>> 2
      : reflectionOffset
    const reflectRightOffset = this.headTracked
      ? (this.reflectionBinauralPointer >>> 2) + this.frameSize
      : reflectionOffset
    const reflectGain = this.headTracked ? 1 : this.control[18]
    const reverbGain = this.control[22]
    const pathWet = this.pathingEnabled ? this.pathControl[this.pathControl.length - 1] : 0
    const pathOffset = this.pathingEnabled ? this.pathBinauralPointer >>> 2 : 0
    for (let index = 0; index < this.frameSize; index++) {
      this.outputLeft[this.outputWrite] = heap[outputOffset + index]
      this.outputRight[this.outputWrite] = heap[outputOffset + this.frameSize + index]
      this.reflectionLeft[this.outputWrite] = heap[reflectLeftOffset + index] * reflectGain
      this.reflectionRight[this.outputWrite] = heap[reflectRightOffset + index] * reflectGain
      this.reverbLeft[this.outputWrite] = heap[reverbOffset + index] * reverbGain
      this.reverbRight[this.outputWrite] = heap[reverbOffset + index] * reverbGain
      if (this.pathingEnabled) {
        this.pathingLeftRing[this.outputWrite] = heap[pathOffset + index] * pathWet
        this.pathingRightRing[this.outputWrite]
          = heap[pathOffset + this.frameSize + index] * pathWet
      }
      this.outputWrite = (this.outputWrite + 1) % this.outputLeft.length
      this.outputCount++
    }
  }
}

registerProcessor('steam-audio-processor', SteamAudioProcessor)

class SteamAudioBusProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const wet = options.processorOptions?.wet
    this.wet = Number.isFinite(wet) && wet >= 0 ? wet : 1
    this.disposed = false
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'wet') {
        this.wet = Number.isFinite(data.value) && data.value >= 0
          ? data.value
          : this.wet
      }
      else if (data?.type === 'dispose') {
        this.disposed = true
      }
    }
  }

  process(inputs, outputs) {
    const input = inputs[0]
    const output = outputs[0]
    for (let channel = 0; channel < output.length; channel++) {
      const source = input?.[channel] ?? input?.[0]
      for (let index = 0; index < output[channel].length; index++)
        output[channel][index] = (source?.[index] ?? 0) * this.wet
    }
    return !this.disposed
  }
}

registerProcessor('steam-audio-bus-processor', SteamAudioBusProcessor)
