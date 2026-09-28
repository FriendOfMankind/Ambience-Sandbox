/// <reference path="./worklet-globals.d.ts" />
import { Limiter } from '../dsp/limiter';

export type LimiterOutMessage = { type: 'meter'; peak: number; minGain: number; nanEvents: number };

const POST_EVERY_BLOCKS = 16;

class LimiterProcessor extends AudioWorkletProcessor {
  private limiter = new Limiter({ sampleRate });
  private blocks = 0;
  private peak = 0;
  private zero = new Float32Array(128);

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const out = outputs[0];
    const outL = out[0];
    const outR = out[1] ?? out[0];
    const frames = outL.length;
    if (!input || input.length === 0) {
      // No connected input this block: feed silence so the delay line drains cleanly.
      if (this.zero.length < frames) this.zero = new Float32Array(frames);
      this.limiter.process(this.zero, this.zero, outL, outR, frames);
    } else {
      const inL = input[0];
      const inR = input[1] ?? input[0];
      this.limiter.process(inL, inR, outL, outR, frames);
    }
    for (let n = 0; n < frames; n++) {
      const a = Math.max(Math.abs(outL[n]), Math.abs(outR[n]));
      if (a > this.peak) this.peak = a;
    }
    if (++this.blocks % POST_EVERY_BLOCKS === 0) {
      const msg: LimiterOutMessage = {
        type: 'meter',
        peak: this.peak,
        minGain: this.limiter.takeMinGain(),
        nanEvents: this.limiter.nanEvents,
      };
      this.port.postMessage(msg);
      this.peak = 0;
    }
    return true;
  }
}

registerProcessor('limiter', LimiterProcessor);
