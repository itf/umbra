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
    // Head-tracked Ambisonic reflections (opt-in). When enabled and an IR has
    // been pushed, the reflected field is rendered by convolving the dry mono
    // source with a per-channel Ambisonic IR and decoding to binaural, instead
    // of mono-duplicating the parametric reflected field.
    this.headTracked = processorOptions.headTracked === true
    this.reflectionOrder = processorOptions.reflectionOrder ?? 1
    this.reflectionChannels = (this.reflectionOrder + 1) * (this.reflectionOrder + 1)
    this.reflectionIr = undefined // { channels, taps, data: Float32Array }
    this.convHistory = undefined // mono input history ring for FIR convolution
    this.convHistoryPos = 0
    this.ambiEffect = 0
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
      else if (data?.type === 'reflection-ir')
        this.setReflectionIr(data)
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
    if (this.ambiEffect) {
      module._sa_ambisonics_binaural_effect_release(this.ambiEffect)
      module._free(this.ambiInPointer)
      module._free(this.ambiOutPointer)
      this.ambiEffect = 0
    }
    this.ready = false
  }

  // Store the latest per-source Ambisonic reflection IR (channels x taps,
  // row-major). Called at the simulation update rate, not audio rate.
  setReflectionIr(data) {
    if (!this.headTracked || !data?.data)
      return
    const channels = Math.min(data.channels, this.reflectionChannels)
    const taps = data.samples
    if (channels <= 0 || taps <= 0)
      return
    this.reflectionIr = { channels, data: data.data, taps }
    if (!this.convHistory || this.convHistory.length < taps) {
      this.convHistory = new Float32Array(taps)
      this.convHistoryPos = 0
    }
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
      this.ambiEffect = createHandle(module, out =>
        module._sa_ambisonics_binaural_effect_create(
          context, sampleRate, this.frameSize, hrtf, this.reflectionOrder, out))
      // Ambisonic field buffer (channels x frameSize) feeding the decode, and
      // its stereo output.
      this.ambiInPointer = allocate(module, this.reflectionChannels * this.frameSize * 4)
      this.ambiOutPointer = allocate(module, 2 * this.frameSize * 4)
    }
    this.ready = true
    this.port.postMessage({ type: 'ready' })
  }

  process(inputs, outputs) {
    const output = outputs[0]
    const reflectionOutput = outputs[1]
    const reverbOutput = outputs[2]
    if (!output?.[0] || !output?.[1]
      || !reflectionOutput?.[0] || !reflectionOutput?.[1]
      || !reverbOutput?.[0] || !reverbOutput?.[1]) {
      return !this.disposed
    }
    const quantumSize = output[0].length
    if (!this.ready) {
      for (const target of [output, reflectionOutput, reverbOutput]) {
        for (const channel of target)
          channel.fill(0)
      }
      return !this.disposed
    }

    this.readSharedControl()
    this.pushInput(inputs[0], quantumSize)
    while (this.inputCount >= this.frameSize)
      this.processBlock()
    this.pullOutput(output, reflectionOutput, reverbOutput, quantumSize)
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
    if (inputActive) {
      module._sa_reflection_effect_apply(
        this.reflectionEffect,
        this.reflectionTimesPointer,
        this.monoPointer,
        this.reflectionPointer,
        this.frameSize,
      )
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
        this.reflectionEffect,
        this.reflectionPointer,
        this.frameSize,
      )
      module._sa_reflection_effect_get_tail(
        this.reverbEffect,
        this.reverbPointer,
        this.frameSize,
      )
    }

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

    // Head-tracked reflected field: convolve the dry mono reflection signal
    // (monoPointer) with the per-channel Ambisonic IR, then decode to binaural.
    // Produces a stereo reflected field that rotates with the head, replacing
    // the mono-duplicated parametric one. Falls back to mono duplication when
    // no IR has arrived yet.
    let headTrackedStereo = false
    if (this.headTracked && this.reflectionIr && this.ambiEffect) {
      headTrackedStereo = this.renderHeadTrackedReflections(heap, monoOffset)
    }

    const ambiOutBase = this.ambiOutPointer >>> 2
    for (let index = 0; index < this.frameSize; index++) {
      this.outputLeft[this.outputWrite] = heap[outputOffset + index]
      this.outputRight[this.outputWrite] = heap[outputOffset + this.frameSize + index]
      const reverbSample = heap[reverbOffset + index] * this.control[22]
      if (headTrackedStereo) {
        const wet = this.control[18]
        this.reflectionLeft[this.outputWrite] = heap[ambiOutBase + index] * wet
        this.reflectionRight[this.outputWrite]
          = heap[ambiOutBase + this.frameSize + index] * wet
      }
      else {
        const reflectionSample = heap[reflectionOffset + index] * this.control[18]
        this.reflectionLeft[this.outputWrite] = reflectionSample
        this.reflectionRight[this.outputWrite] = reflectionSample
      }
      this.reverbLeft[this.outputWrite] = reverbSample
      this.reverbRight[this.outputWrite] = reverbSample
      this.outputWrite = (this.outputWrite + 1) % this.outputLeft.length
      this.outputCount++
    }
  }

  // Direct multichannel FIR convolution of the dry mono reflection signal (at
  // heap[monoOffset..]) with the Ambisonic IR, followed by Ambisonics-binaural
  // decode. Writes stereo into ambiOutPointer. Returns true on success.
  // Cost ~ channels * taps MACs per output sample; keep taps modest (irTaps).
  renderHeadTrackedReflections(heap, monoOffset) {
    const { module } = this.runtime
    const ir = this.reflectionIr
    const taps = ir.taps
    const channels = ir.channels
    const history = this.convHistory
    const histLen = history.length
    const ambiInBase = this.ambiInPointer >>> 2

    for (let index = 0; index < this.frameSize; index++) {
      // Append the new mono sample to the history ring.
      this.convHistoryPos = (this.convHistoryPos + 1) % histLen
      history[this.convHistoryPos] = heap[monoOffset + index]
      // For each Ambisonic channel, accumulate FIR(history, ir[ch]).
      for (let ch = 0; ch < channels; ch++) {
        const irOffset = ch * taps
        let acc = 0
        let h = this.convHistoryPos
        for (let t = 0; t < taps; t++) {
          acc += ir.data[irOffset + t] * history[h]
          h = h === 0 ? histLen - 1 : h - 1
        }
        heap[ambiInBase + ch * this.frameSize + index] = acc
      }
    }
    const status = module._sa_ambisonics_binaural_effect_apply(
      this.ambiEffect,
      this.runtime.hrtf,
      this.reflectionOrder,
      this.ambiInPointer,
      this.ambiOutPointer,
      this.frameSize,
    )
    return status === 0
  }

  pullOutput(output, reflectionOutput, reverbOutput, quantumSize) {
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
