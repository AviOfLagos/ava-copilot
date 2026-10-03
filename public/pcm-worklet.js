// Hands the recorder mono samples in batches of about a quarter second at 16 kHz.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.size = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      this.pending.push(channel.slice());
      this.size += channel.length;
      if (this.size >= 4096) {
        const batch = new Float32Array(this.size);
        let offset = 0;
        for (const part of this.pending) {
          batch.set(part, offset);
          offset += part.length;
        }
        this.port.postMessage(batch, [batch.buffer]);
        this.pending = [];
        this.size = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
