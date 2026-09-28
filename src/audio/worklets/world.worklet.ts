/// <reference path="./worklet-globals.d.ts" />
import { WorldSynth, type WorldEvents, type WorldFeatures, type WorldParamsPatch } from '../world/WorldSynth';

export type WorldInMessage = { type: 'params'; patch: WorldParamsPatch } | { type: 'stop' };
export type WorldOutMessage = {
  type: 'tick';
  events: WorldEvents;
  features: WorldFeatures;
  /** Synth frame and context time at the end of the last rendered block, to map frames to time. */
  frame: number;
  time: number;
  rainStats: { voices: number; dropped: number };
};

const POST_EVERY_BLOCKS = 6; // ~16 ms at 48 kHz

class WorldProcessor extends AudioWorkletProcessor {
  private world: WorldSynth;
  private blocks = 0;
  /** Disconnecting a node does not stop its processor; returning false from process() does. */
  private alive = true;

  constructor(options: AudioWorkletNodeOptions) {
    super(options);
    const opts = (options.processorOptions ?? {}) as { seed?: string; patch?: WorldParamsPatch };
    this.world = new WorldSynth(sampleRate, opts.seed ?? 'default', opts.patch);
    this.port.onmessage = (e: MessageEvent<WorldInMessage>) => {
      if (e.data.type === 'params') this.world.setParams(e.data.patch);
      else if (e.data.type === 'stop') this.alive = false;
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const l = out[0];
    const r = out[1] ?? out[0];
    this.world.process(l, r, l.length);
    if (++this.blocks % POST_EVERY_BLOCKS === 0) {
      const events = this.world.drainEvents();
      // Only near drops are drawn; cap what we send across threads.
      if (events.rain.length > 200) events.rain.splice(0, events.rain.length - 200);
      const msg: WorldOutMessage = {
        type: 'tick',
        events,
        features: this.world.features(),
        frame: this.world.frame,
        time: currentTime + l.length / sampleRate,
        rainStats: { voices: this.world.rain.stats.voices, dropped: this.world.rain.stats.dropped },
      };
      this.port.postMessage(msg);
    }
    return this.alive;
  }
}

registerProcessor('world', WorldProcessor);
