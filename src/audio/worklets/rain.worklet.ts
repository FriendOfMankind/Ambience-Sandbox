/// <reference path="./worklet-globals.d.ts" />
import { RainSynth, type RainEvent, type RainParams } from '../nature/rain/RainSynth';

export type RainInMessage = { type: 'params'; params: Partial<RainParams> };
export type RainOutMessage = {
  type: 'events';
  events: RainEvent[];
  /** Synth frame and context time at the end of the last rendered block, to map frames to time. */
  frame: number;
  time: number;
  stats: RainSynth['stats'];
};

const POST_EVERY_BLOCKS = 8; // ~21 ms at 48 kHz

class RainProcessor extends AudioWorkletProcessor {
  private synth: RainSynth;
  private blocks = 0;

  constructor(options: AudioWorkletNodeOptions) {
    super(options);
    const opts = (options.processorOptions ?? {}) as { seed?: string; params?: Partial<RainParams> };
    this.synth = new RainSynth(sampleRate, opts.seed ?? 'default', opts.params);
    this.port.onmessage = (e: MessageEvent<RainInMessage>) => {
      if (e.data.type === 'params') this.synth.setParams(e.data.params);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const l = out[0];
    const r = out[1] ?? out[0];
    this.synth.process(l, r, l.length);
    if (++this.blocks % POST_EVERY_BLOCKS === 0) {
      const msg: RainOutMessage = {
        type: 'events',
        events: this.synth.drainEvents(),
        frame: this.synth.frame,
        time: currentTime + l.length / sampleRate,
        stats: { ...this.synth.stats },
      };
      this.port.postMessage(msg);
    }
    return true;
  }
}

registerProcessor('rain', RainProcessor);
