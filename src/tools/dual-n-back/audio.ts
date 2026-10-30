// The Sound Modality's player: recordings decoded once into buffers and
// played through Web Audio, so a sound starts the moment its Trial does.

export class Player {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, Promise<AudioBuffer>>();
  private playing: AudioBufferSourceNode[] = [];

  private context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
    }
    return this.ctx;
  }

  /** Call from a user gesture: browsers only let audio start from one. */
  unlock() {
    const ctx = this.context();
    if (ctx.state === "suspended") {
      void ctx.resume();
    }
  }

  /** Decodes the recordings a Session will play, each only the first time it is asked for. */
  prepare(urls: string[]): Promise<unknown> {
    const ctx = this.context();
    return Promise.all(
      urls.map((url) => {
        let b = this.buffers.get(url);
        if (!b) {
          b = fetch(url)
            .then((r) => r.arrayBuffer())
            .then((data) => ctx.decodeAudioData(data));
          // A failure is not kept: the next Session tries again.
          b.catch(() => this.buffers.delete(url));
          this.buffers.set(url, b);
        }
        return b;
      })
    );
  }

  /** Silences whatever is still sounding from the last trial. */
  stop() {
    for (const s of this.playing) {
      try {
        s.stop();
      } catch {
        /* already ended */
      }
    }
    this.playing = [];
  }

  /** Plays one Trial's recording. */
  async play(url: string) {
    this.stop();
    const ctx = this.context();
    const buffer = await this.buffers.get(url);
    if (buffer) {
      const source = new AudioBufferSourceNode(ctx, { buffer });
      source.connect(ctx.destination);
      source.onended = () =>
        (this.playing = this.playing.filter((s) => s !== source));
      this.playing.push(source);
      source.start();
    }
  }
}
