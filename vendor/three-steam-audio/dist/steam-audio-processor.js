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
    // Head-tracked reflections (opt-in). The directional, head-tracked reflected
    // field is rendered OUTSIDE this worklet: the reflection-simulation worker
    // bakes a per-pose binaural STEREO impulse response (see
    // reflection-simulator-worker.js) and the main thread convolves the dry
    // beacon through a Web Audio ConvolverNode. So when headTracked is set, this
    // worklet's reflection output (output[1]) carries only the DRY MONO
    // reflection-send signal (duplicated to both channels) for that ConvolverNode
    // to filter — it does NOT itself convolve or decode. When headTracked is off,
    // output[1] carries the legacy mono-duplicated parametric reflected field.
    this.headTracked = processorOptions.headTracked === true
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
    this.applyParametricBuses(module, inputActive)

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

    // Reflection send (output[1]):
    //  * headTracked: emit the DRY MONO reflection-send signal (monoPointer,
    //    which here holds the dry input downmix) scaled by wet, duplicated to
    //    both channels. The main-thread ConvolverNode convolves this with the
    //    per-pose binaural stereo IR baked by the worker, producing the
    //    directional, head-tracked reflected field. No convolution/decode here.
    //  * legacy: emit the mono-duplicated parametric reflected field.
    for (let index = 0; index < this.frameSize; index++) {
      this.outputLeft[this.outputWrite] = heap[outputOffset + index]
      this.outputRight[this.outputWrite] = heap[outputOffset + this.frameSize + index]
      const reverbSample = heap[reverbOffset + index] * this.control[22]
      const reflectionSample = this.headTracked
        ? heap[monoOffset + index] * this.control[18]
        : heap[reflectionOffset + index] * this.control[18]
      this.reflectionLeft[this.outputWrite] = reflectionSample
      this.reflectionRight[this.outputWrite] = reflectionSample
      this.reverbLeft[this.outputWrite] = reverbSample
      this.reverbRight[this.outputWrite] = reverbSample
      this.outputWrite = (this.outputWrite + 1) % this.outputLeft.length
      this.outputCount++
    }
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
